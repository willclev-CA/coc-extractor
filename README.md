# COC Extractor — Crystal Analytical LLC

PLM-FRM-010 Bulk Asbestos Chain of Custody OCR tool.  
Extracts Sample Number, HA, Material Location, and Material Description from PDF COC forms and exports to Excel.

---

## Deploy to Netlify (one-time setup)

### 1. Get an Anthropic API key
Go to https://console.anthropic.com → API Keys → Create Key.  
Copy the key — you'll need it in step 4.

### 2. Push this folder to GitHub
Create a new GitHub repository and push this folder to it:
```
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_ORG/coc-extractor.git
git push -u origin main
```

### 3. Connect to Netlify
1. Log in at https://netlify.com
2. Click **Add new site → Import an existing project**
3. Choose GitHub and select your repository
4. Build settings are auto-detected from `netlify.toml` — no changes needed
5. Click **Deploy site**

### 4. Add your API key
1. In Netlify, go to **Site Settings → Environment Variables**
2. Click **Add a variable**
3. Key: `ANTHROPIC_API_KEY`
4. Value: paste your key from step 1
5. Click **Save** — Netlify will redeploy automatically

Your site is now live. Share the Netlify URL with your team.

---

## Access control (optional)

To restrict access to Crystal Analytical staff only, enable **Netlify Password Protection**:  
Site Settings → Access & Security → Password protection → Enable

---

## Local development

```bash
npm install
npm install -g netlify-cli
cp .env.example .env        # add your API key to .env
netlify dev                 # runs app + functions together at localhost:8888
```

---

## How it works

1. Browser renders each PDF page to a JPEG using PDF.js (all local, no upload)
2. JPEG is sent to `/api/extract` — a serverless Netlify Function
3. The function calls the Anthropic API with your secret key (never exposed to the browser)
4. Extracted JSON is returned and displayed in the table
5. Export to Excel runs entirely in the browser via SheetJS
