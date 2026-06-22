# Multi-user Workspace

New authenticated project data is scoped by user:

```text
workspace/
  liclick.db
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

Legacy `workspace/projects` is kept for old local data, but new authenticated project writes use `workspace/users/<userId>/projects`.
