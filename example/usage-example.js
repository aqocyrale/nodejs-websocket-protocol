/**
	@howtouse
		run
		$ node ./websocket-protocol-example.js
		
		visit localhost on a web browser of your choice,
		open dev tools, play around with the websocket object
		
		review the example code and edit the web server to handle more requests
		
		review the implementation to get the idea of the full API you can work with,
		createClientConnection creates a web socket connection as a client,
		serverUpgradeRequest handles "upgrade" requests on an existing HTTP server,
		and returns server-side web socket connections per valid upgrade request
		
		the web socket connection object is symmetrical for both clients and servers.
		review its API at lines 410-428
*/

'use strict';

// import

const Http = require('http');
const { createClientConnection, serverUpgradeRequest } = require('../src/websocket-protocol');

// static

const LISTEN_PORT = 80;

// run

start();

// functions

function start() {
	const httpServer = Http.createServer(onHttpRequest);
	httpServer.on('upgrade', onUpgrade);
	httpServer.listen(LISTEN_PORT, onListen);
}

function onListen() {
	console.log('listening to HTTP on localhost:' + LISTEN_PORT);
}

function onUpgrade(request, socket) {
	serverUpgradeRequest(request, socket, {}, (error, webSocketConnection) => {
		if(error) {
			console.error('WebSocket upgrade failed:', error);
			socket.end(); // call socket.end() unless you want to continue to other upgrade options
			return;
		}
		
		webSocketConnection.setOnTextMessage(string => {
			
			// echo client messages to console
			console.log('client message:', string);
			
			// route specific requests to specific logic
			switch(string) {
				case 'close-connection':
					return webSocketConnection.end();
				case 'send-ping':
					return webSocketConnection.sendPing();
				case 'print-last-sync-date':
					return console.log(webSocketConnection.getLastSyncDate());
				default:
					// echo client messages back to client
					return webSocketConnection.sendTextMessage(string + ' from server');
			}
		});
		
		webSocketConnection.setOnSync(syncDate => {
			console.log('onSyncDateUpdated:', syncDate.toISOString());
		});
		
		webSocketConnection.setOnEnd(code => {
			console.log('WebSocket connection closed:', code);
		});
	});
}

function onHttpRequest(request, response) {
	response.statusCode = 200;
	response.setHeader('content-type', 'text/html');
	response.end(`
		<!DOCTYPE html>
		<html>
			<head>
				<meta charset="utf-8">
				<title>WebSocket Client</title>
				<script>
					'use strict';
					
					const webSocketClient = new WebSocket(location.origin.replace('http', 'ws'));
					webSocketClient.onmessage = message => {
						// echo server messages to console
						console.log('server message:', message.data);
					};
					
					// send messages from console manually to see it in action
					console.log("webSocketClient.send('my-message'); // try this");
				</script>
			</head>
			<body>
				<h1>Press F12 | open browser dev tools</h1>
			</body>
		</html>
	`);
}
