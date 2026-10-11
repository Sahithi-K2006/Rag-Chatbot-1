# Deployment

The shortest reliable path is **Render**, using the Blueprint in `render.yaml`. It defines:

- **knowledgebridge-api**: Python web service with a **persistent disk** at `/var/data` for uploads, the registry, the Chroma index and the cached embedding model.
- **knowledgebridge-web**: static site built from `frontend/` with `VITE_API_BASE_URL` pointing at the API.

Other hosts work the same way if they provide a persistent volume. Do not deploy the backend on a host with only an ephemeral filesystem (for example serverless functions or a free tier without disks): every restart would silently empty the knowledge base.

> This repository has **not** been deployed by the author. The Blueprint is syntax-checked and the production configuration was exercised locally (production mode, access key, strict CORS, separate origins), but the Render build itself is unverified.

## Requirements

| | |
|---|---|
| Backend RAM | About 1 GB (PyTorch + `all-MiniLM-L6-v2`). Use Render **Standard (2 GB)**; Starter (512 MB) will likely run out of memory. |
| Disk | 2 GB is plenty for hundreds of small documents and the model cache. Must be persistent. |
| Instances | Exactly **one** backend instance with one worker. Rate limits, locks and Chroma are per-process. |
| Gemini key | From Google AI Studio. Free-tier keys can be limited to **20 requests per day per model**, and each chat message uses 2 calls (router + answer). Enable billing for real use, or set `LLM_ROUTER_MODEL=` (empty) to use one call per message. |

## Environment variables

Backend (`knowledgebridge-api`):

| Name | Required | Example / note |
|---|---|---|
| `ENVIRONMENT` | yes | `production` (refuses to start without `API_ACCESS_KEY`) |
| `GEMINI_API_KEY` | yes | `<your-gemini-api-key>` |
| `API_ACCESS_KEY` | yes in production | `<long-random-string>`, generated with `python -c "import secrets; print(secrets.token_urlsafe(24))"` |
| `CORS_ORIGINS` | yes | `https://<your-frontend>.onrender.com` (comma-separated, no trailing slash) |
| `DATA_DIR` | yes | `/var/data/kb` (on the persistent disk) |
| `HF_HOME` | recommended | `/var/data/hf-cache`, so the embedding model is downloaded once |
| `LLM_MODEL` / `LLM_ROUTER_MODEL` | no | `gemini-2.5-flash` / `gemini-2.5-flash-lite` |
| `MAX_UPLOAD_MB`, `MAX_DOCUMENTS`, `CHAT_REQUESTS_PER_MINUTE`, `UPLOADS_PER_MINUTE` | no | limits, see `backend/.env.example` |

Frontend (`knowledgebridge-web`):

| Name | Required | Example |
|---|---|---|
| `VITE_API_BASE_URL` | yes | `https://<your-api>.onrender.com`, read at **build** time. Rebuild after changing it. |

## Steps (Render)

1. Push this repository to GitHub. Check that `backend/.env` is **not** committed (`.gitignore` excludes it).
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`.
3. When prompted, set:
   - `GEMINI_API_KEY`: your key
   - `API_ACCESS_KEY`: a long random string; share it only with intended users
   - `CORS_ORIGINS`: leave a placeholder for now (e.g. `https://example.com`)
   - `VITE_API_BASE_URL`: leave a placeholder for now
4. After the first deploy, copy the two public URLs, then set:
   - API service `CORS_ORIGINS` = the web URL (e.g. `https://knowledgebridge-web.onrender.com`)
   - Web service `VITE_API_BASE_URL` = the API URL (e.g. `https://knowledgebridge-api.onrender.com`)
   - Redeploy **both** (the frontend must rebuild to pick up the URL).
5. Verify (next section).

Build and start commands used by the Blueprint:

```bash
# backend (rootDir backend/)
pip install --upgrade pip && pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1
# frontend (rootDir frontend/)
npm ci && npm run build      # output: frontend/dist
```

The CPU-only PyTorch index keeps the install around 1 GB instead of several GB of CUDA libraries. Initialization needs no separate step: on first start the backend creates `DATA_DIR/{uploads,chroma}` and `documents.json`, and downloads the embedding model on the first upload (about 90 MB, cached under `HF_HOME`).

## Verify the deployment

```bash
API=https://<your-api>.onrender.com
KEY=<your-access-key>
curl -s $API/api/health                                    # {"status":"ok"}
curl -s $API/api/ready                                     # storage true, llm_configured true, access_key_required true
curl -s -o /dev/null -w "%{http_code}\n" $API/api/documents                       # 401 without the key
curl -s -H "X-Access-Key: $KEY" $API/api/documents                                # []
curl -s -H "X-Access-Key: $KEY" -F "file=@backend/sample_docs/returns_policy.pdf" $API/api/documents
```

Then open the web URL, enter the access key, attach a PDF with the paperclip, wait for "ready", and ask a question whose answer is in the PDF. Check that the citation opens the right passage. Ask something the PDF doesn't cover and check that the assistant says so. Finally, redeploy the API and check the document is still listed: that confirms the disk is persistent.

## Operations

- **Backups**: snapshot the Render disk or copy `/var/data/kb` (uploads + `documents.json` + `chroma/` together).
- **Clearing data**: delete documents in the UI, or stop the service and remove `/var/data/kb`.
- **Changing `EMBEDDING_MODEL` or `CHUNK_SIZE`**: re-index every document (Documents page → Re-index).
- **Logs**: contain intents, counts and similarity scores, never document text, prompts or keys.

## Pre-launch checklist

- [ ] `ENVIRONMENT=production` and a strong `API_ACCESS_KEY` set
- [ ] `CORS_ORIGINS` is exactly the frontend URL
- [ ] `VITE_API_BASE_URL` points at the API and the frontend was rebuilt after setting it
- [ ] Backend has a persistent disk and `DATA_DIR` is on it
- [ ] `/api/ready` returns `storage: true, llm_configured: true`
- [ ] Gemini billing or quota fits expected usage (free tier can be 20 requests/day/model)
- [ ] Upload → ask → citation → "not found" flow tested on the deployed URL
- [ ] Data persists across a redeploy
- [ ] Users know this is a single shared knowledge base: anyone with the access key can read and delete every document
