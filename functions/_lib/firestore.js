let tokenCache = null;

const textEncoder = new TextEncoder();
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function jsonResponse(code, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json", ...extraHeaders }
  });
}

function textResponse(code, body) {
  return new Response(body, { status: code });
}

function base64Url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  arr.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8Base64Url(obj) {
  return base64Url(textEncoder.encode(JSON.stringify(obj)));
}

function parseServiceAccount(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT || "{}";
  const sa = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key.");
  }
  return sa;
}

function pemToArrayBuffer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: FIRESTORE_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  };
  const unsigned = utf8Base64Url(header) + "." + utf8Base64Url(claim);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, textEncoder.encode(unsigned));
  return unsigned + "." + base64Url(sig);
}

async function accessToken(env) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const sa = parseServiceAccount(env);
  const assertion = await signJwt(sa);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(body.error_description || body.error || ("token HTTP " + res.status));
  tokenCache = { token: body.access_token, exp: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function dbBase(env) {
  const sa = parseServiceAccount(env);
  return "https://firestore.googleapis.com/v1/projects/" +
    encodeURIComponent(sa.project_id) + "/databases/(default)/documents";
}

function encodeDocPath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

async function firestoreFetch(env, path, options = {}) {
  const token = await accessToken(env);
  const res = await fetch(dbBase(env) + "/" + encodeDocPath(path), {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (res.status === 404) return null;
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = body.error && body.error.message ? body.error.message : ("Firestore HTTP " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

function fromValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return !!v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return ((v.arrayValue || {}).values || []).map(fromValue);
  if ("mapValue" in v) return fromFields(((v.mapValue || {}).fields || {}));
  return null;
}

function fromFields(fields) {
  const out = {};
  Object.entries(fields || {}).forEach(([k, v]) => { out[k] = fromValue(v); });
  return out;
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

function toFields(obj) {
  const fields = {};
  Object.entries(obj || {}).forEach(([k, v]) => { fields[k] = toValue(v); });
  return fields;
}

async function getDoc(env, path) {
  const doc = await firestoreFetch(env, path);
  return doc ? fromFields(doc.fields || {}) : null;
}

async function setDoc(env, path, data) {
  return firestoreFetch(env, path, {
    method: "PATCH",
    body: JSON.stringify({ fields: toFields(data) })
  });
}

async function createDoc(env, collectionPath, docId, data) {
  const token = await accessToken(env);
  const res = await fetch(dbBase(env) + "/" + encodeDocPath(collectionPath) + "?documentId=" + encodeURIComponent(docId), {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFields(data) })
  });
  if (res.ok) return true;
  const body = await res.json().catch(() => ({}));
  const msg = body.error && body.error.message ? body.error.message : "";
  if (res.status === 409 || /already exists/i.test(msg)) return false;
  throw new Error(msg || ("Firestore create HTTP " + res.status));
}

async function listDocs(env, collectionPath) {
  const token = await accessToken(env);
  const res = await fetch(dbBase(env) + "/" + encodeDocPath(collectionPath), {
    headers: { Authorization: "Bearer " + token }
  });
  if (res.status === 404) return [];
  const body = await res.json();
  if (!res.ok) throw new Error((body.error && body.error.message) || ("Firestore list HTTP " + res.status));
  return (body.documents || []).map(doc => ({
    id: String(doc.name || "").split("/").pop(),
    data: fromFields(doc.fields || {})
  }));
}

export { createDoc, getDoc, jsonResponse, listDocs, setDoc, textResponse };
