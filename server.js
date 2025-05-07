const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve the static HTML file to the client
app.use(express.static('public'));

// Endpoint to receive AI messages (for example, via POST request)
app.post('/send', express.json(), (req, res) => {
    const { command, who_is_talking, response, is_user_talking, timestamp } = req.body;

    // Log the received data
    console.log('Received data:', req.body);

    // Process the command (e.g., if it's asking for weather)
    let processedResponse = '';
    if (command.toLowerCase().includes("what's the weather in frank")) {
        processedResponse = 'Das Wetter in Frankfurt ist momentan sonnig und 22°C.';
    } else {
        processedResponse = 'Ich konnte die Wetterinformation nicht finden.';
    }

    // Send the processed message to all connected clients via WebSocket
    io.emit('new_message', {
        command,
        who_is_talking,
        response: processedResponse,
        is_user_talking,
        timestamp
    });

    res.json({ status: 'Message processed and sent to clients' });
});

// Start the server
server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});
