# YouTube Video Collector

A modern Electron application that helps you watch YouTube videos and create timestamp markers for later export.

## Features

✨ **Split-Screen Interface**
- Left: Embedded YouTube browser
- Right: Control panel with markers and export options

⏱️ **Easy Marker System**
- Press **N** while watching to mark timestamps
- Visual markers appear on the YouTube timeline
- Click markers to jump to that timestamp
- Right-click or use × button to remove markers
- Undo button to remove the last marker

📊 **Data Management**
- Track multiple YouTube videos in a session
- Build rows with video URLs and their timestamps
- Export complete data to CSV format

💾 **CSV Export**
- Export format: `url,timestamp1;timestamp2;...,url,timestamp1;timestamp2;...`
- One row per group of related videos
- Timestamps in decimal seconds (e.g., 12.5, 45.3)

## Installation

1. Navigate to the project directory:
   ```bash
   cd youtube-video-collecting
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   ```bash
   npm start
   ```

## How to Use

### Basic Workflow

1. **Navigate to YouTube**: The application opens with YouTube loaded in the left panel

2. **Add Markers while Watching**:
   - Play a YouTube video
   - Press **N** at the moments you want to mark
   - Markers appear in the right panel and on the timeline

3. **Manage Markers**:
   - Click a marker time to jump to that position in the video
   - Click the **×** button next to a marker to remove it
   - Use **↶ Undo** button to remove the last marker

4. **Collect Video Data**:
   - Once you have all markers for a video, click **Take URL + Markers**
   - This captures the video URL and all timestamps for this row

5. **Continue with More Videos**:
   - Navigate to another YouTube video
   - Add new markers (the marker list clears after "Take URL + Markers")
   - Click **Next Row** to move markers into a new row group

6. **Export to CSV**:
   - When done collecting, click **Export CSV**
   - Choose a location and filename
   - The file will be saved with your complete dataset

### Marker List Panel

- **Current URL**: Shows the URL of the YouTube page
- **Markers**: Lists all markers added during current video with timestamps in MM:SS format
- **Take URL + Markers**: Captures this video's data
- **Next Row**: Creates a new row group
- **Export CSV**: Saves all collected data to a CSV file
- **Current Row**: Shows what data has been collected for the current row
- **Status**: Displays row count and active marker count

## CSV Output Format

```
https://youtube.com/watch?v=A,12.5;20.1;45.0,https://youtube.com/watch?v=B,3.2;6.4
https://youtube.com/watch?v=C,5.1;9.8
```

Each line represents a group/row.
Each video contributes two columns: URL and semicolon-separated timestamps.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **N** | Add marker at current video time |
| Click marker | Jump to that timestamp |
| Right-click marker | Remove marker |
| × button | Remove marker |

## Tips & Tricks

- **Precision**: Timestamps show decimal precision (e.g., 12.5 seconds)
- **Multiple Videos per Row**: You can add multiple videos to one row by clicking "Take URL + Markers" multiple times before "Next Row"
- **Large Sessions**: The app supports large collections - no limits on markers or rows
- **Import CSV**: You can open exported CSV files in Excel, Google Sheets, or any spreadsheet application

## System Requirements

- Windows 10 or later
- At least 100MB of free disk space
- Internet connection for YouTube access

## Development

### Scripts

```bash
npm start     # Start development app with DevTools
npm run make  # Build installers for distribution
npm run lint  # Run linter checks
```

### Project Structure

```
src/
├── index.js          # Main process (Electron)
├── index.html        # UI structure
├── index.css         # Styling
├── preload.js        # Secure bridge to main process
├── renderer.js       # UI controller and data management
└── content-script.js # YouTube page injection script
```

## Troubleshooting

### "Marker: 0:00" appears but no marker visible on timeline
- YouTube's timeline DOM might have changed
- Try refreshing the YouTube page and try again

### URL not updating
- Ensure you're on a standard YouTube watch page (youtube.com/watch?v=...)
- The URL updates automatically every 3 seconds

### DevTools console is open
- This is intentional for development
- You can close it with DevTools menu or F12 if needed

## License

MIT License - See LICENSE file for details

## Support

For issues or feature requests, please check the project repository or contact the developer.

---

**Made with ❤️ for YouTube researchers and content reviewers**
