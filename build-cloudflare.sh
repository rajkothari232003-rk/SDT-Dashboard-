#!/usr/bin/env sh
set -eu

rm -rf public
mkdir -p public

cp index.html public/
cp firestore.rules public/
cp SETUP.md public/
cp _headers public/
cp _routes.json public/
cp -R js public/
cp -R gmail-backup public/
