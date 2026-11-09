#!/usr/bin/env bash
# Prepares a Google Cloud project for the bot with the gcloud CLI:
# creates (or reuses) a project and enables the Calendar, Gmail, Tasks, Drive, Docs, Sheets and People APIs.
# Google does not allow scripting the OAuth consent screen or downloading the client file,
# so the script ends by printing the two pages to finish in your browser.
#
# Usage:  bash scripts/setup-gcp.sh [project-id]
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed. Get it from https://cloud.google.com/sdk/docs/install, or follow the manual steps in SETUP-GUIDE.md."
  exit 1
fi

PROJECT_ID="${1:-secretary-bot-$(date +%s | tail -c 7)}"

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
  echo "Signing in to Google Cloud..."
  gcloud auth login
fi

if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Using existing project $PROJECT_ID"
else
  echo "Creating project $PROJECT_ID"
  gcloud projects create "$PROJECT_ID" --name="Secretary Bot"
fi
gcloud config set project "$PROJECT_ID" >/dev/null

echo "Enabling Calendar, Gmail, Tasks, Drive, Docs, Sheets and Contacts APIs (takes a minute)..."
gcloud services enable \
  calendar-json.googleapis.com \
  gmail.googleapis.com \
  tasks.googleapis.com \
  drive.googleapis.com \
  docs.googleapis.com \
  sheets.googleapis.com \
  people.googleapis.com

cat <<MSG

✅ Project $PROJECT_ID is ready. Two steps left in your browser:

1. OAuth consent screen (Google Auth Platform):
   https://console.cloud.google.com/auth/overview?project=$PROJECT_ID
   - Get started: app name "Secretary Bot", your email, Audience: External.
   - Audience > Test users: add your own Gmail address.
   - Then click "Publish app" (In production). Unverified is fine for personal use, and
     without this Google signs you out every 7 days.

2. OAuth client:
   https://console.cloud.google.com/auth/clients?project=$PROJECT_ID
   - Create client > Application type: Desktop app > Create.
   - Download the JSON, rename it to credentials.json and put it in the bot's data/ folder.

Then run:  npm run google-auth

Optional, Google Maps (places and travel times; needs a billing account on the project):
   gcloud services enable places.googleapis.com routes.googleapis.com
   then create an API key at https://console.cloud.google.com/apis/credentials?project=$PROJECT_ID
   and put it in .env as GOOGLE_MAPS_API_KEY.
MSG
