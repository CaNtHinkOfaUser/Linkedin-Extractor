# LinkedIn Profile Extractor — Chrome Extension

Extract an entire LinkedIn profile, every section and every entry, into a clean `.txt` file (and `.json`) with one click.

---

## What It Extracts

The profile page only previews each section ("Show all 97 skills →"), so the extractor also opens every section's **Show all** page and reads the complete list.

| Section              | Fields captured                                                                 |
|----------------------|---------------------------------------------------------------------------------|
| Personal Info        | Name, Pronouns, Headline, Current company/school, Location, Connections, Followers |
| Contact Info         | Profile URL, Websites, Email, Phone, Birthday, …                                |
| About                | Full summary text (line breaks kept), Top skills                                |
| Experience           | Title, Company, Employment type, Dates, Duration, Location, Workplace, Description, Skills, Media |
| Education            | School, Degree, Field, Dates, Grade, Activities, Description, Skills            |
| Skills               | **Every** skill, its category (Industry Knowledge, Tools & Technologies, …), where it's used, endorsements |
| Certifications       | Name, Issuer, Issued, Expires, Credential ID, Credential URL, Skills, Media     |
| Projects             | Name, Dates, Associated with, Description, URL, Skills, Media                   |
| Volunteering         | Role, Organization, Dates, Cause, Description, Media                            |
| Honors & Awards      | Title, Issuer, Date, Associated with, Description, Media                        |
| Courses              | Name, Number, Associated with                                                   |
| Test Scores          | Name, Score, Date, Associated with, Description                                 |
| Languages            | Language, Proficiency                                                           |
| Publications         | Title, Publisher, Date, Description, URL                                        |
| Patents              | Title, Number, Date, Description, URL                                           |
| Organizations        | Name, Position, Dates, Description                                              |
| Recommendations      | Received and Given: From, Headline, Date, Relationship, Full text               |
| Featured             | Type, Title, Description, Links                                                 |
| Interests            | Companies, Groups, Schools, … with follower counts                              |
| Causes               | Each cause                                                                      |

Skill lists cut short on an entry ("Swift, iOS Development, +2 skills") are filled in from the Skills page.

---

## Installation

1. Download / clone this folder
2. Open Chrome → go to `chrome://extensions/`
3. Enable **Developer Mode** (top-right toggle)
4. Click **"Load unpacked"**
5. Select this folder

After pulling a new version, click the reload ↻ icon on the extension card **and reload any open LinkedIn tabs**.

---

## How to Use

1. Sign in to LinkedIn and open any profile: `linkedin.com/in/username` (a `/details/…` page of that profile works too)
2. Click the extension icon → **EXTRACT FULL PROFILE**
3. An overlay appears on the tab and loads each section's page in turn. **Keep the tab in front** until it finishes, usually 1–2 minutes. LinkedIn only loads more entries while the page is visible, so the extractor pauses if you switch tabs.
4. When it finishes, `firstname-lastname_YYYY-MM-DD.txt` downloads automatically
5. Reopen the popup any time to download the last extract again as **.TXT** or **.JSON**, preview it, or copy it

You can close the popup while it runs; the extraction continues on the page. **Cancel** in the overlay stops it.

---

## File Structure

```
linkedin-extractor/
├── manifest.json      # Chrome Extension manifest (v3)
├── content.js         # Scraper — runs on linkedin.com/in/*, drives the overlay
├── background.js      # Service worker — saves the .txt / .json download
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic: start, progress, download buttons
├── icons/
└── README.md
```

---

## Permissions Used

| Permission    | Why                                                         |
|---------------|-------------------------------------------------------------|
| `activeTab`   | Read the current LinkedIn tab                               |
| `scripting`   | Inject content.js into tabs opened before the extension     |
| `downloads`   | Save the extracted `.txt` / `.json` file                    |
| `storage`     | Keep the last extract so the popup can re-download it       |

No data is sent anywhere. Everything runs locally in your browser.
