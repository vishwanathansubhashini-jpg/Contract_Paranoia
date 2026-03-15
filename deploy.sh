#!/usr/bin/env bash
# ── Cost-optimized Cloud Run deployment with Vertex AI ───────────────────────
#
# Estimated cost: ~$1-5/month on light usage (well within $300 free credit)
#
# Cost controls:
#   - Cloud Run scales to ZERO when idle (no charge)
#   - Max 1 instance (prevents runaway scaling)
#   - CPU throttled when no requests
#   - SQLite in /tmp (no Cloud SQL = saves ~$9/month)
#   - Vertex AI is pay-per-request (no idle cost)
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project YOUR_PROJECT_ID
#
#   Enable APIs:
#     gcloud services enable run.googleapis.com
#     gcloud services enable aiplatform.googleapis.com
#     gcloud services enable secretmanager.googleapis.com
#     gcloud services enable storage.googleapis.com
#
#   Store your API key in Secret Manager (optional fallback):
#     echo -n "YOUR_KEY" | gcloud secrets create GOOGLE_API_KEY --data-file=-
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_ID=$(gcloud config get-value project)
REGION="us-central1"
SERVICE="contract-paranoia"
SA_NAME="${SERVICE}-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "=== Deploying $SERVICE to $PROJECT_ID ($REGION) ==="
echo "Mode: Vertex AI + Cloud Run (scale-to-zero)"

# ── Create a dedicated service account (least privilege) ─────────────────────
if ! gcloud iam service-accounts describe "$SA_EMAIL" &>/dev/null 2>&1; then
  echo "Creating service account: $SA_NAME"
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Contract Paranoia Service Account"
fi

# Grant Vertex AI access
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/aiplatform.user" \
  --quiet

# Grant Secret Manager access (if using secrets)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet

# ── Deploy to Cloud Run ─────────────────────────────────────────────────────
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA_EMAIL" \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 1 \
  --timeout 300 \
  --concurrency 80 \
  --cpu-throttling \
  --set-env-vars "\
GCP_PROJECT=$PROJECT_ID,\
GCP_LOCATION=$REGION,\
USE_VERTEX=true,\
DATA_DIR=/tmp/data,\
LOG_LEVEL=INFO" \
  --quiet

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')

echo ""
echo "============================================"
echo "  Deployed: $URL"
echo "============================================"
echo ""
echo "Cost controls active:"
echo "  - Scales to 0 when idle (no charge)"
echo "  - Max 1 instance (no runaway scaling)"
echo "  - CPU throttled between requests"
echo "  - Vertex AI: pay-per-request only"
echo "  - SQLite in /tmp (no Cloud SQL)"
echo ""
echo "Vertex AI auth: service account $SA_EMAIL"
echo "  (uses ADC — no API key needed in production)"
echo ""
echo "NOTE: /tmp data resets on cold start (fine for hackathon demo)."
