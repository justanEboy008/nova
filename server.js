const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ApiClient } = require('@twurple/api');
const { AppTokenAuthProvider } = require('@twurple/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, 'nova-log.json');
const CALENDAR_FILE = path.join(__dirname, 'calendar-events.json');

// Load Twitch configuration
const twitchConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'twitch.json'), 'utf8'));

// Initialize Twitch client
const authProvider = new AppTokenAuthProvider(twitchConfig.clientId, twitchConfig.clientSecret);
const twitchClient = new ApiClient({ authProvider });

// Load or initialize calendar events
let calendarEvents = [];
try {
    if (fs.existsSync(CALENDAR_FILE)) {
        calendarEvents = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
    } else {
        fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendarEvents));
    }
} catch (error) {
    console.error('Error loading calendar events:', error);
}

// Middleware setup
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
app.use('/config', express.static(path.join(__dirname, 'config')));

let currentStatus = { status: 'offline', timestamp: new Date().toISOString() };
let logs = [];

// Load logs from file on start
try {
  if (fs.existsSync(LOG_FILE)) {
    const fileData = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    logs = fileData.map(line => JSON.parse(line));
    console.log(`Loaded ${logs.length} log entries from file`);
  }
} catch (error) {
  console.error('Error loading logs:', error);
}

// Append log entry to memory + file
function appendToLog(logEntry) {
  try {
    logs.push(logEntry);
    fs.appendFile(LOG_FILE, JSON.stringify(logEntry) + '\n', err => {
      if (err) console.error('Error writing to log file:', err);
    });
  } catch (error) {
    console.error('Error appending to log:', error);
  }
}

// Log receiving endpoint
app.post('/log-data', (req, res) => {
  try {
    const { command, who_is_talking, response, is_user_talking, timestamp, forecast } = req.body;

    if (!command || typeof who_is_talking !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }

    const isWeather = /weather/.test(command.toLowerCase());
    const logEntry = { 
      command, 
      who_is_talking, 
      response, 
      is_user_talking, 
      timestamp: timestamp || new Date().toISOString(), 
      isWeather, 
      forecast 
    };

    appendToLog(logEntry);

    console.log(`[${logEntry.timestamp}] ${who_is_talking}: ${command}`);
    if (response) console.log(`Nova: ${response}`);
    console.log(`User speaking: ${is_user_talking}`);

    res.status(200).json({ message: 'Log received.' });
  } catch (error) {
    console.error('Error processing log data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Status endpoints
app.post('/status', (req, res) => {
  try {
    const { status, timestamp } = req.body;
    if (status) {
      currentStatus = { 
        status, 
        timestamp: timestamp || new Date().toISOString() 
      };
      console.log(`Status update: ${status}`);
      return res.status(200).json({ message: 'Status updated.' });
    } else {
      return res.status(400).json({ error: 'Missing status field' });
    }
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/status', (req, res) => {
  res.json(currentStatus);
});

// Logs endpoint
app.get('/logs', (req, res) => {
  try {
    res.json(logs);
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Twitch stream endpoint
app.get('/twitch-stream', async (req, res) => {
    try {
        const streams = [];
        
        for (const channelName of twitchConfig.channels) {
            try {
                const user = await twitchClient.users.getUserByName(channelName);
                if (!user) continue;

                const stream = await twitchClient.streams.getStreamByUserId(user.id);
                if (!stream) continue;

                const game = await twitchClient.games.getGameById(stream.gameId);

                streams.push({
                    isLive: true,
                    previewUrl: stream.thumbnailUrl.replace('{width}', '320').replace('{height}', '180'),
                    title: stream.title,
                    streamerName: user.displayName,
                    gameName: game?.name || 'Unknown Game',
                    viewerCount: stream.viewers
                });
            } catch (error) {
                console.error(`Error fetching stream for ${channelName}:`, error);
                continue;
            }
        }

        res.json(streams);
    } catch (error) {
        console.error('Error fetching Twitch streams:', error);
        res.status(500).json({ error: 'Error fetching stream data' });
    }
});

// Calendar endpoints
app.get('/calendar-events', (req, res) => {
    try {
        const { month, year } = req.query;
        console.log('\n=== Fetching Calendar Events ===');
        console.log('Query parameters:', { month, year });
        
        if (!month || !year) {
            console.error('Missing month or year parameters');
            return res.status(400).json({ error: 'Month and year are required' });
        }

        const filteredEvents = calendarEvents.filter(event => {
            const eventDate = new Date(event.date);
            return eventDate.getMonth() === parseInt(month) && 
                   eventDate.getFullYear() === parseInt(year);
        });
        
        console.log('Found events:', JSON.stringify(filteredEvents, null, 2));
        console.log('=== End Fetch ===\n');
        res.json(filteredEvents);
    } catch (error) {
        console.error('Error fetching calendar events:', error);
        res.status(500).json({ error: 'Error fetching calendar events' });
    }
});

// Endpoint for both Python scripts and frontend to add events
app.post('/calendar-events', (req, res) => {
    try {
        console.log('\n=== Calendar Event Addition Request ===');
        console.log('Request headers:', req.headers);
        console.log('Request body:', JSON.stringify(req.body, null, 2));
        
        const { title, date, time, description } = req.body;
        
        // Validate required fields
        if (!title || !date) {
            console.error('Missing required fields:', { title, date });
            return res.status(400).json({ error: 'Title and date are required' });
        }

        // Format date if it's not in ISO format
        let formattedDate = date;
        if (!date.includes('T')) {
            const [year, month, day] = date.split('-');
            // If year is not provided or is less than 100, use current year
            const currentYear = new Date().getFullYear();
            const yearToUse = (!year || year.length < 4) ? currentYear : parseInt(year);
            formattedDate = `${yearToUse}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }

        // Set default time if not provided
        const eventTime = time || '00:00';

        const newEvent = {
            id: Date.now().toString(),
            title,
            date: formattedDate,
            time: eventTime,
            description: description || '',
            createdAt: new Date().toISOString(),
            source: req.headers['user-agent']?.includes('Python') ? 'python_script' : 'frontend'
        };

        console.log('Adding new event:', JSON.stringify(newEvent, null, 2));
        calendarEvents.push(newEvent);
        
        // Ensure the calendar file exists
        if (!fs.existsSync(CALENDAR_FILE)) {
            console.log('Creating new calendar file');
            fs.writeFileSync(CALENDAR_FILE, '[]');
        }
        
        // Write to file
        console.log('Writing events to file:', JSON.stringify(calendarEvents, null, 2));
        fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendarEvents, null, 2));
        
        console.log('✓ Event added successfully');
        console.log('=== End Request ===\n');
        
        res.json({ 
            message: 'Event added successfully',
            event: newEvent
        });
    } catch (error) {
        console.error('Error adding calendar event:', error);
        res.status(500).json({ error: 'Error adding calendar event' });
    }
});

// Alias for Python scripts to maintain backward compatibility
app.post('/add-calendar-event', (req, res) => {
    // Forward the request to the main endpoint
    req.url = '/calendar-events';
    app.handle(req, res);
});

app.delete('/calendar-events/:id', (req, res) => {
    try {
        const { id } = req.params;
        calendarEvents = calendarEvents.filter(event => event.id !== id);
        fs.writeFileSync(CALENDAR_FILE, JSON.stringify(calendarEvents));
        res.json({ message: 'Event deleted successfully' });
    } catch (error) {
        console.error('Error deleting calendar event:', error);
        res.status(500).json({ error: 'Error deleting calendar event' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Nova server running at http://localhost:${PORT}`);
});
