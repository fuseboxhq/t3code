# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Default model for new threads

New threads in a project start with the model and effort set under **New threads** in its project settings.
Where a project sets a model but no effort, the workspace-wide default fills the effort in.

The workspace-wide default lives in Settings under **Providers**, in the **New threads** row.
It applies to every project that has not chosen its own default model.
Resolution is most specific first: the project's default, then the workspace default, then the provider's own defaults.
Clearing the project setting falls back to the workspace default; clearing both falls back to the provider.
