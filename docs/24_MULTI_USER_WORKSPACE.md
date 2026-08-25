# Multi-user Workspace

New authenticated project data is scoped by user:

```text
workspace/
  auth.json
  users/
    <userId>/
      folders.json
      user-settings.json
      projects/
        <projectSlug>/
          project.liclick.json
          assets/
          exports/
          thumbnails/
      trash/
        projects/
```

The server routes for folders, projects, assets, and export require a valid Liclick session before reading or writing user-scoped data. Static asset URLs use `/workspace/users/<userId>/projects/...` and path resolution stays under the configured workspace root.

Legacy `workspace/projects` is kept for old local data, but authenticated main-service writes use `workspace/users/<userId>/projects`. The Windows local component also uses a user-scoped workspace rooted in that Windows user's application-data area.

The exact set of JSON files varies by auth, job, telemetry, and local-component mode. `liclick.db` is not required by the current runtime; Prisma/SQLite remains a migration target. File isolation is suitable for one server instance, not a substitute for database transactions or distributed locking.
