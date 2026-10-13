# Privacy and storage

## What stays local

In the desktop app, canvases, model credentials, imported documents, and local session mirrors are stored on your machine. Canvas state uses IndexedDB; optional folder backup writes explicit `.thoughtdag.json` files.

## What can leave the device

Content leaves the device only through a feature that requires transfer:

- a model request to a remote endpoint;
- a search or external tool call;
- a share URL you create and send;
- a backup folder managed by a third-party sync service;
- an exported file you distribute.

PDF files remain local during ordinary reading. Extracted text or selected material may be sent when it is included in a remote model request.

## Credentials

Keys configured in the interface are kept in local browser storage and proxy memory. They are not included in normal canvas backups. Always review the policy of the model or tool endpoint you connect.

## Leftover index from the why layer

Earlier versions shipped a why layer (a command line, MCP tools, and Harness tools) that indexed local agent sessions into `~/.thoughtdag`. It has been removed. If you used it, these files are no longer read and can be deleted by hand: `fact-index.json`, `text-index.json`, `text-index.jsonl`, `interpretation-cache.json`, and the `canvases/` folder. Keep `workspaces/`: agent turns run there. Deleting the index does not touch source sessions.

## Harness plugin

The embedded canvas uses browser storage under the Harness web origin. Harness manages its model configuration, credentials, and session logs. The plugin accesses supported logs on the machine running Harness, which need not be the browser client's machine.

Matching history returned by query tools may enter an agent's next model request and be sent to the selected remote provider. New turns through **DeepSeek Harness · Agent** are recorded in Harness logs; editing the canvas does not delete those logs.

## Web demo

The hosted demo uses browser-local canvas storage and browser-direct model connections where supported. It does not provide the full set of desktop-local capabilities.
