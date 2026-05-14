# LinkedIn Profile Extractor — Chrome Extension

Extract any LinkedIn profile into a clean, structured `.txt` file with one click.

---

## What It Extracts

| Section              | Fields captured                                      |
|----------------------|------------------------------------------------------|
| Personal Info        | Name, Headline, Location, Connections                |
| About                | Full summary text                                    |
| Experience           | Title, Company, Duration, Location, Description     |
| Education            | School, Degree, Field, Duration, Description         |
| Skills               | Skill name, Endorsement count                        |
| Certifications       | Name, Issuer, Issue date, Credential ID, URL         |
| Projects             | Name, Duration, Description, URL                    |
| Volunteer Experience | Role, Organization, Duration, Cause, Description    |
| Languages            | Language, Proficiency level                          |
| Honors & Awards      | Title, Issuer, Date, Description                     |
| Publications         | Title, Publisher, Date, Description                  |
| Courses              | Name, Course number                                  |
| Recommendations      | From, Their role, Full recommendation text           |

---

## Sample Output

```
════════════════════════════════════════════════════════════
  LINKEDIN PROFILE EXTRACT
  Extracted: 2/24/2026, 10:30:00 AM
  Source: https://www.linkedin.com/in/johndoe/
════════════════════════════════════════════════════════════

════════════════════════════════════════════════════════════
  PERSONAL INFORMATION
════════════════════════════════════════════════════════════
  Name: John Doe
  Headline: Software Engineer at Acme Corp
  Location: Singapore

════════════════════════════════════════════════════════════
  LICENSES & CERTIFICATIONS
════════════════════════════════════════════════════════════

  ▸ Certification 1
  ──────────────────────────────────────────────────
  Name: AWS Certified Solutions Architect
  Issuer: Amazon Web Services
  Issued: Issued Jan 2024
  Credential ID: ABC123XYZ
```

---

## Installation

1. Download / clone this folder
2. Open Chrome → go to `chrome://extensions/`
3. Enable **Developer Mode** (top-right toggle)
4. Click **"Load unpacked"**
5. Select the `linkedin-extractor` folder

The extension icon will appear in your toolbar.

---

## How to Use

1. Go to any LinkedIn profile: `linkedin.com/in/username`
2. **Scroll through the full profile** so LinkedIn's lazy-loader renders all sections
3. Click the extension icon in your toolbar
4. Click **"EXTRACT & DOWNLOAD"**
5. A `.txt` file is saved automatically (named `firstname-lastname_YYYY-MM-DD.txt`)
6. Use **Preview** to see the output in the popup, or **Copy Text** to copy to clipboard

---

## Tips for Best Results

- **Scroll the full page first** — LinkedIn lazy-loads sections as you scroll
- Click **"Show all"** on Experience, Education, and Skills sections to reveal hidden entries
- For Recommendations, click the "Received" tab to load them
- Works on both your own profile and other people's public profiles

---

## File Structure

```
linkedin-extractor/
├── manifest.json      # Chrome Extension manifest (v3)
├── content.js         # Page scraper — runs on linkedin.com/in/*
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic, messaging, file download
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Permissions Used

| Permission    | Why                                               |
|---------------|---------------------------------------------------|
| `activeTab`   | Read the current LinkedIn tab                     |
| `scripting`   | Inject content.js to scrape the page              |
| `downloads`   | Save the extracted `.txt` file to your computer   |

No data is sent anywhere, everything runs locally in your browser.
