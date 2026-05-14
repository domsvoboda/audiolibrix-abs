# audiolibrix-abs

A small [Audiobookshelf](https://www.audiobookshelf.org/) custom metadata provider for **Audiolibrix.cz**.

It searches public Audiolibrix.cz catalogue pages and returns audiobook metadata in a format Audiobookshelf can use. 

Returned metadata can include:

- title
- author
- narrator
- publisher
- description
- cover
- genres
- language
- duration

## Screenshots
<img width="791" height="640" alt="abs-audiolibrix1" src="https://github.com/user-attachments/assets/7bd969f6-2315-4e3d-9f8b-84142de01de8" />
<img width="791" height="640" alt="abs-audiolibrix2" src="https://github.com/user-attachments/assets/2d1ff8c3-4d72-469d-9131-e92feec7e8f6" />



## Quick start

Create `compose.yml`:

```yaml
---
services:
  audiolibrix-abs:
    image: domsv/audiolibrix-abs:latest
    container_name: audiolibrix-abs
    environment:
      - PORT=3000
      - AUTH_TOKEN=
      - ADD_AUDIOLIBRIX_LINK_TO_DESCRIPTION=true
      - METADATA_CONCURRENCY=3
      - MAX_SEARCH_RESULTS=10
      - REQUEST_TIMEOUT_MS=15000
    restart: unless-stopped
    ports:
      - "3000:3000"
```

Start the container:

```bash
docker compose up -d
```

Check that it is running:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "ok": true,
  "provider": "Audiolibrix"
}
```

## Audiobookshelf setup

In Audiobookshelf, add a custom metadata provider:

```text
Name: Audiolibrix
URL: http://YOUR_SERVER_IP:3000
Authorization Header Value: leave empty if AUTH_TOKEN is empty
```

If you set `AUTH_TOKEN`, use the same value in Audiobookshelf:

```yaml
environment:
  - AUTH_TOKEN=my-secret-token
```

Audiobookshelf:

```text
Authorization Header Value: my-secret-token
```

## Configuration

| Variable | Required | Default | Description |
|---|---:|---:|---|
| `PORT` | No | `3000` | Port used by the Node app inside the container |
| `AUTH_TOKEN` | No | empty | Optional shared secret. If empty, authorization is disabled |
| `ADD_AUDIOLIBRIX_LINK_TO_DESCRIPTION` | No | `true` | Adds the Audiolibrix.cz source link to the description |
| `METADATA_CONCURRENCY` | No | `3` | Number of detail pages fetched in parallel |
| `MAX_SEARCH_RESULTS` | No | `10` | Maximum number of search results to inspect |
| `REQUEST_TIMEOUT_MS` | No | `15000` | Request timeout for Audiolibrix.cz in milliseconds |

## API

### Health check

```http
GET /health
```

Example:

```bash
curl http://localhost:3000/health
```

### Search

```http
GET /search?query=<title>
```

Supported query parameters:

| Parameter | Required | Description |
|---|---:|---|
| `query` | Yes | Book title, search text, or direct Audiolibrix.cz book URL |
| `title` | No | Alternative to `query` |
| `author` | No | Optional author name appended to the search query |

Examples:

```bash
curl 'http://localhost:3000/search?query=Metro%202033'
```

```bash
curl 'http://localhost:3000/search?title=Metro%202033&author=Dmitry%20Glukhovsky'
```

## Local development

Clone the repository:

```bash
git clone https://github.com/domsvoboda/audiolibrix-abs.git
cd audiolibrix-abs
```

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm start
```

Syntax check:

```bash
npm run check
```

Local Docker build for development:

```yaml
---
services:
  audiolibrix-abs:
    build: .
    container_name: audiolibrix-abs
    environment:
      - PORT=3000
      - AUTH_TOKEN=
      - ADD_AUDIOLIBRIX_LINK_TO_DESCRIPTION=true
      - METADATA_CONCURRENCY=3
      - MAX_SEARCH_RESULTS=10
      - REQUEST_TIMEOUT_MS=15000
    restart: unless-stopped
    ports:
      - "3000:3000"
```

## Dependencies

Runtime dependencies are intentionally minimal:

- Node.js built-in `http` server
- Node.js built-in `fetch`
- `cheerio` for HTML parsing
