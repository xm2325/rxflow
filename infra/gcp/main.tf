data "google_project" "current" {}

locals {
  required_apis = toset([
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com"
  ])
}

resource "google_project_service" "required" {
  for_each           = local.required_apis
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "rxflow_api" {
  account_id   = "rxflow-api"
  display_name = "RxFlow API runtime"
}

resource "google_service_account" "rxflow_worker" {
  account_id   = "rxflow-outbox-worker"
  display_name = "RxFlow outbox worker runtime"
}

resource "google_project_iam_member" "api_cloud_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.rxflow_api.email}"
}

resource "google_project_iam_member" "worker_cloud_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.rxflow_worker.email}"
}

resource "google_artifact_registry_repository" "rxflow" {
  location      = var.region
  repository_id = "rxflow"
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

resource "google_sql_database_instance" "rxflow" {
  name             = var.database_instance_name
  region           = var.region
  database_version = "POSTGRES_17"

  settings {
    tier              = var.database_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      ipv4_enabled = true
    }
  }

  deletion_protection = var.database_deletion_protection
  depends_on          = [google_project_service.required]
}

resource "google_sql_database" "rxflow" {
  name     = var.database_name
  instance = google_sql_database_instance.rxflow.name
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "google_sql_user" "rxflow" {
  name     = var.database_user
  instance = google_sql_database_instance.rxflow.name
  password = random_password.database.result
}

resource "google_secret_manager_secret" "database_password" {
  secret_id = "${var.service_name}-database-password"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "database_password" {
  secret      = google_secret_manager_secret.database_password.id
  secret_data = random_password.database.result
}

resource "google_secret_manager_secret_iam_member" "api_database_password" {
  secret_id = google_secret_manager_secret.database_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.rxflow_api.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_database_password" {
  secret_id = google_secret_manager_secret.database_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.rxflow_worker.email}"
}

resource "google_pubsub_topic" "events" {
  name       = "rxflow-events"
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic" "dead_letter" {
  name       = "rxflow-events-dead-letter"
  depends_on = [google_project_service.required]
}

resource "google_pubsub_subscription" "dead_letter" {
  name  = "rxflow-events-dead-letter-retain"
  topic = google_pubsub_topic.dead_letter.id

  message_retention_duration = "604800s"
}

resource "google_pubsub_subscription" "workflow" {
  name  = "rxflow-workflow"
  topic = google_pubsub_topic.events.id

  ack_deadline_seconds = 30

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# Request-serving API. It writes the transactional outbox but never publishes it.
# The separate worker owns Pub/Sub credentials and delivery CPU.
resource "google_cloud_run_v2_service" "api" {
  name                = var.service_name
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.rxflow_api.email

    containers {
      image = var.container_image

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "RXFLOW_RUNTIME_ROLE"
        value = "api"
      }
      env {
        name  = "RXFLOW_CLOUD_SQL_INSTANCE"
        value = google_sql_database_instance.rxflow.connection_name
      }
      env {
        name  = "RXFLOW_PGDATABASE"
        value = google_sql_database.rxflow.name
      }
      env {
        name  = "RXFLOW_PGUSER"
        value = google_sql_user.rxflow.name
      }
      env {
        name = "RXFLOW_PGPASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_password.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "RXFLOW_PG_SCHEMA_MODE"
        value = "verify"
      }
      env {
        name  = "RXFLOW_PG_POOL_MAX"
        value = tostring(var.postgres_pool_max)
      }
      env {
        name  = "RXFLOW_PUBLISH_INTERVAL_MS"
        value = "0"
      }
      env {
        name  = "RXFLOW_OUTBOX_PENDING_AGE_TARGET_MS"
        value = tostring(var.outbox_pending_age_target_ms)
      }
      env {
        name  = "RXFLOW_EXTERNAL_OUTBOX_WORKER"
        value = "true"
      }
      env {
        name  = "RXFLOW_TRUST_PLATFORM_IAM"
        value = "true"
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.rxflow.connection_name]
      }
    }

    scaling {
      min_instance_count = var.cloud_run_min_instances
      max_instance_count = var.cloud_run_max_instances
    }
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.api_cloud_sql_client,
    google_secret_manager_secret_iam_member.api_database_password
  ]
}

# Dedicated delivery worker. Multiple instances can safely claim the same durable
# queue because claims are lease-based and PostgreSQL uses SKIP LOCKED.
resource "google_cloud_run_v2_service" "outbox_worker" {
  name                = "${var.service_name}-outbox-worker"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.rxflow_worker.email

    containers {
      image   = var.container_image
      command = ["node"]
      args    = ["dist/src/worker-server.js"]

      resources {
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "RXFLOW_RUNTIME_ROLE"
        value = "worker"
      }
      env {
        name  = "RXFLOW_CLOUD_SQL_INSTANCE"
        value = google_sql_database_instance.rxflow.connection_name
      }
      env {
        name  = "RXFLOW_PGDATABASE"
        value = google_sql_database.rxflow.name
      }
      env {
        name  = "RXFLOW_PGUSER"
        value = google_sql_user.rxflow.name
      }
      env {
        name = "RXFLOW_PGPASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_password.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "RXFLOW_PG_SCHEMA_MODE"
        value = "verify"
      }
      env {
        name  = "RXFLOW_PG_POOL_MAX"
        value = tostring(var.worker_postgres_pool_max)
      }
      env {
        name  = "RXFLOW_PUBLISH_INTERVAL_MS"
        value = tostring(var.worker_publish_interval_ms)
      }
      env {
        name  = "RXFLOW_OUTBOX_PER_TENANT_CLAIM_LIMIT"
        value = tostring(var.worker_per_tenant_claim_limit)
      }
      env {
        name  = "RXFLOW_OUTBOX_TENANT_DELIVERY_CONCURRENCY"
        value = tostring(var.worker_tenant_delivery_concurrency)
      }
      env {
        name  = "RXFLOW_OUTBOX_PENDING_AGE_TARGET_MS"
        value = tostring(var.outbox_pending_age_target_ms)
      }
      env {
        name  = "RXFLOW_PUBSUB_PROJECT"
        value = var.project_id
      }
      env {
        name  = "RXFLOW_PUBSUB_TOPIC"
        value = google_pubsub_topic.events.name
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.rxflow.connection_name]
      }
    }

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.worker_cloud_sql_client,
    google_secret_manager_secret_iam_member.worker_database_password,
    google_pubsub_topic_iam_member.worker_event_publisher
  ]
}

# Explicit schema migration boundary; normal API/worker startup verifies only.
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${var.service_name}-migrate"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.rxflow_api.email
      max_retries     = 1
      timeout         = "600s"

      containers {
        image   = var.container_image
        command = ["node"]
        args    = ["dist/src/migrate-postgres.js"]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "RXFLOW_CLOUD_SQL_INSTANCE"
          value = google_sql_database_instance.rxflow.connection_name
        }
        env {
          name  = "RXFLOW_PGDATABASE"
          value = google_sql_database.rxflow.name
        }
        env {
          name  = "RXFLOW_PGUSER"
          value = google_sql_user.rxflow.name
        }
        env {
          name = "RXFLOW_PGPASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_password.secret_id
              version = "latest"
            }
          }
        }
        env {
          name  = "RXFLOW_PG_SCHEMA_MODE"
          value = "migrate"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.rxflow.connection_name]
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.api_cloud_sql_client,
    google_secret_manager_secret_iam_member.api_database_password
  ]
}

locals {
  pubsub_service_agent = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  topic  = google_pubsub_topic.dead_letter.name
  role   = "roles/pubsub.publisher"
  member = local.pubsub_service_agent
}

resource "google_pubsub_subscription_iam_member" "workflow_subscriber" {
  subscription = google_pubsub_subscription.workflow.name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}

resource "google_pubsub_topic_iam_member" "worker_event_publisher" {
  topic  = google_pubsub_topic.events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.rxflow_worker.email}"
}
