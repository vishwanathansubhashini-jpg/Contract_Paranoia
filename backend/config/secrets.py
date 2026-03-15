"""Secret Manager integration with env var fallback for local dev."""

import logging
import os

logger = logging.getLogger("para.secrets")


def get_secret(secret_id: str, project_id: str | None = None) -> str:
    """Fetch secret from Secret Manager. Falls back to env var for local dev."""
    # Local dev: env var takes precedence
    env_val = os.environ.get(secret_id)
    if env_val:
        return env_val

    try:
        from google.cloud import secretmanager

        client = secretmanager.SecretManagerServiceClient()
        project = project_id or os.environ.get("GCP_PROJECT")
        if not project:
            raise ValueError("GCP_PROJECT required for Secret Manager")
        name = f"projects/{project}/secrets/{secret_id}/versions/latest"
        response = client.access_secret_version(request={"name": name})
        logger.info("Secret loaded from Secret Manager: %s", secret_id)
        return response.payload.data.decode("UTF-8")
    except ImportError:
        logger.warning("google-cloud-secret-manager not installed, secret %s not found", secret_id)
        return ""
    except Exception as e:
        logger.error("Failed to fetch secret %s: %s", secret_id, e)
        return ""
