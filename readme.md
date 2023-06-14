# [nodejs] [@aqo/websocket-protocol] [1.0.0]

## Install @ npm
```shell
npm install github:aqocyrale/nodejs-websocket-protocol
```

## Import @ nodejs
```js
require('@aqo/websocket-protocol')
```

## Description

Implementation of RFC 6455, The WebSocket Protocol.
An upgrade to an HTTP 1.1 GET request that keeps the socket open,
allowing bi-directional messaging by a client server pair.

## Supports

- WebSocket server
- WebSocket client (for NodeJS)
- ping messages (protocol level minimal size ping)
- text messages
- binary messages
- lightweight, high performance
- automatic protocol level masking
- upgrading existing http server

## Examples

Run `node example/usage-example.js` for a usage example.

The short version is:
```js
const Http = require('http');
const { serverUpgradeRequest } = require('@aqo/websocket-protocol');

const protocolOptions = {}; // don't change this if you don't know what it's for

Http.createServer().on('upgrade', (request, socket) => {
	serverUpgradeRequest(request, socket, protocolOptions, (error, webSocketConnection) => {
		if(error) {
			return console.error(error);
		}
		
		// create event handlers for: messages received from client websocket, socket end
		
		webSocketConnection.setOnTextMessage(string => console.log(string));
		webSocketConnection.setOnBinaryMessage(buffer => console.log(buffer));
		webSocketConnection.setOnSync(syncDate => console.log(syncDate));
		webSocketConnection.setOnEnd(code => console.log(code));

		// send messages from server to client

		webSocketConnection.sendTextMessage('');
		webSocketConnection.sendBinaryMessage(Buffer.from(''));
		webSocketConnection.sendPing(Buffer.from(''));

		// check state of socket

		webSocketConnection.isOpen(); // Boolean
		webSocketConnection.getLastSyncDate(); // Date
	});
});
```

On a browser you can just use the regular WebSocket interface.
```js
const webSocketClient = new WebSocket(location.origin.replace('http', 'ws'));

// create event handler for: text messages received from server websocket

webSocketClient.onmessage = message => console.log(message.data);

// send messages from client to server

webSocketClient.send('my-message');
```

You will probably want to handle many open sockets on the server side.
Just create a regular js object or a Map or your data structure of choice,
insert any webSocketConnection object you receive in there if no error,
and delete any webSocketConnection from it when the end event is called.

You will probably want to periodically send pings over the socket,
if your higher level layer shuts down open sockets with no traffic on them.
Just make a loop that periodically calls sendPing from each webSocketConnection
in your data structure of choice.

If you want to send JSON messages, just send text messages encoded as JSON.
If you want to send minimal messages for best performance at scale,
use the binary messages option.
On the client side, you can use Blob or any TypedArrays for binary messages.

## License

MIT
