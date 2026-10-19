# LinkedIn Profile Extractor — Chrome Extension

Extract a LinkedIn profile into a clean `.txt` file: every section and every entry, or just the sections you pick.

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
2. Click the extension icon and tick the sections you want under **Sections to extract** (All / None to toggle quickly; your choice is remembered). Untick *Tag each skill's category* if you don't need categories — it's the slowest part.
3. Click **Extract**. A progress card covers the tab while the pages load behind it, several at once. **Keep the tab in front** until it finishes; LinkedIn only loads more entries while the page is visible, so the extractor pauses if you switch tabs. Fewer sections finish faster.
4. When it's done, click **⬇ Download** to save `firstname-lastname_YYYY-MM-DD.txt`, or **📋 Copy text** to copy it. **Preview** shows it in the popup.

You can close the popup while it runs; the extraction continues on the page, and the result is waiting when you reopen the popup. **Cancel** on the card stops it.

---

## File Structure

```
linkedin-extractor/
├── manifest.json      # Chrome Extension manifest (v3)
├── content.js         # Scraper — runs on linkedin.com/in/*, drives the progress card
├── background.js      # Service worker — saves the .txt download
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic: section picker, start, progress, download/copy
├── icons/
└── README.md
```

---

## Permissions Used

| Permission    | Why                                                         |
|---------------|-------------------------------------------------------------|
| `activeTab`   | Read the current LinkedIn tab                               |
| `scripting`   | Inject content.js into tabs opened before the extension     |
| `downloads`   | Save the extracted `.txt` file when you click Download      |
| `storage`     | Keep the last extract and your section choices              |

No data is sent anywhere. Everything runs locally in your browser.
