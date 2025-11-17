# Custom Gates Folder

Drop reusable JSON snapshots (same schema as `state.json`) here to make them available in the Logic Circuit Lab palette.

- Each file must include the normal `gates`, `connections`, and `nextId` fields.
- Use `input` gates to define the custom gate’s pins (labels will become the port names) and `output` gates to expose the outputs.
- Files are discovered automatically when the client loads, so placing a new JSON file here instantly registers a new reusable custom gate without having to rebuild it on the canvas.
