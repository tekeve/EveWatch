# EVE Log Watcher

EVE Log Watcher is a real-time web-based application for monitoring EVE Online game and chat logs.

## Prerequisites

Before running the application on your Windows machine, ensure you have the following installed:
- [Node.js](https://nodejs.org/) (which includes npm, the Node package manager)

## Installation and Setup

1. Open your command prompt (or PowerShell).
2. Navigate to the `LogWatch` directory within this repository:
   ```bash
   cd LogWatch
   ```
3. Install the required dependencies:
   ```bash
   npm install
   ```
4. Start the application:
   ```bash
   npm start
   ```

## Accessing the App

Once the application is running, open your preferred web browser and navigate to:
[http://localhost:3000](http://localhost:3000)

## Log Path Auto-Detection

By default, the application will automatically attempt to find your EVE Online logs in the standard Windows directories:
- `Documents\EVE\logs`
- `OneDrive\Documents\EVE\logs`

If your logs are located in a different directory, you can update the log path directly from the web interface once the application is running.

## Troubleshooting

- **Client Focus Feature Not Working**: EVE Log Watcher includes a feature that uses a PowerShell script to bring the EVE client window to the foreground. If this feature does not seem to work, your EVE Online client might be running with Administrator privileges. To fix this, you will need to open your command prompt or PowerShell as an **Administrator**, navigate back to the `LogWatch` directory, and run `npm start` again.
