# Publishing Artifacts To Prototypes

PORTICO publishes artifacts from the artifact panel with the **Publish** button. The flow targets `https://prototypes.example.invalid`.

## Flow

1. PORTICO checks for a Prototypes `koa.sess` cookie. If it is missing, PORTICO opens `/add-ai-project` so the user can complete Golf Cart sign-in.
2. PORTICO reads the materialized artifact files from `workspaces/<chatId>/artifacts/<artifactId>`.
3. PORTICO skips generated/cache folders such as `node_modules`, `.git`, `.cache`, and `__pycache__`.
4. PORTICO packages source files as the Prototypes upload API expects:
   - text files use raw text content
   - binary assets use base64 content
   - relative file paths are preserved as `name`
5. PORTICO infers the project type:
   - `html` for static HTML artifacts
   - `typescript` when TypeScript/React-style source files are present
6. PORTICO creates a Prototypes project with a slug generated from the artifact name and AI sandbox tags.
7. PORTICO uploads the files by calling the GitLab pipeline trigger route for the created project.

## API Calls

PORTICO follows the same route shape as the Prototypes Dashboard upload page:

- `GET /api/gitlab/availability`
- `POST /api/projects`
- `POST /api/gitlab/projects/:projectId/trigger-pipeline`

If Prototypes returns `GITLAB_UNAVAILABLE`, the request reached Prototypes successfully, but the downstream build pipeline is unavailable.
