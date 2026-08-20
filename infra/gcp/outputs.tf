output "cloud_run_service" {
  value = google_cloud_run_v2_service.api.name
}

output "migration_job" {
  value = google_cloud_run_v2_job.migrate.name
}

output "cloud_sql_instance" {
  value = google_sql_database_instance.rxflow.name
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.rxflow.connection_name
}

output "events_topic" {
  value = google_pubsub_topic.events.id
}

output "dead_letter_topic" {
  value = google_pubsub_topic.dead_letter.id
}
