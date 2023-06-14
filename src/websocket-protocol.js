'use strict';

// import

const Net = require('net');
const Tls = require('tls');
const Crypto = require('crypto');

// static

const CRLF = '\r\n';

const WEB_SOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC-6455 [1.3] [4.2.2]

const HANDSHAKE_KEY_SIZE = 16;
const HANDSHAKE_KEY_BASE64_SIZE = getBase64Length(HANDSHAKE_KEY_SIZE);
const MASKING_KEY_SIZE = 4;
const STATUS_CODE_UPGRADED = 101;

const OPCODE_CONTINUATION_FRAME = 0x0;
const OPCODE_TEXT_FRAME = 0x1;
const OPCODE_BINARY_FRAME = 0x2;
const OPCODE_CONNECTION_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xA;

const FRAME_DATA_PING_UNMASKED = createHeaderOnlyUnmaskedFrame(OPCODE_PING);
const FRAME_DATA_PONG_UNMASKED = createHeaderOnlyUnmaskedFrame(OPCODE_PONG);
const FRAME_DATA_PING_MASKED = createHeaderOnlyMaskedFrame(OPCODE_PING);
const FRAME_DATA_PONG_MASKED = createHeaderOnlyMaskedFrame(OPCODE_PONG);

// export

module.exports = {
	createClientConnection,
	serverUpgradeRequest,
};

// functions

function createClientConnection({
	url = 'http://127.0.0.1:80',
	headers = {},
	protocols = [],
}, callback) {
	const {
		protocol,
		host,
		hostname,
		port,
		pathname,
		search,
	} = new URL(url);
	
	const isHttps = protocol === 'https:';
	const inferredPort = port !== '' ? Number(port) : isHttps ? 433 : 80;
	
	const requestHeaders = toLowerCaseKeys(headers);
	
	Crypto.randomBytes(HANDSHAKE_KEY_SIZE, onRandomBytes);
	
	// functions
	
	function onRandomBytes(error, buffer) {
		if(error) return callback(error);
		const secWebSocketKey = buffer.toString('base64');
		
		const socket = (isHttps ? Tls : Net).connect({
			host: hostname,
			port: inferredPort,
		}, onConnected);
		socket.on('end', onHandshakeEnd);
		socket.on('error', onHandshakeError);
		
		// functions
		
		function onConnected() {
			Object.assign(requestHeaders, {
				'host': host,
				'upgrade': 'websocket',
				'connection': 'keep-alive, upgrade',
				'sec-websocket-key': secWebSocketKey,
				'sec-websocket-version': '13',
			});
			
			if(protocols.length > 0) {
				requestHeaders['sec-websocket-protocol'] = protocols.join(', ');
			}
			
			// be prepared to listen to server handshake response
			
			socket.on('data', onServerHandshake);
			
			// send client handshake
			
			socket.write([
				'GET ' + pathname + search + ' HTTP/1.1',
				...serializeHttpHeaders(requestHeaders),
				CRLF,
			].join(CRLF));
		}
		
		function onServerHandshake(buffer) {
			
			// pass event listener control to WebSocketConnection if success, else just remove
			
			socket.removeListener('end', onHandshakeEnd);
			socket.removeListener('error', onHandshakeError);
			socket.removeListener('data', onServerHandshake);
			
			const [ statusLine, ...lines ] = buffer.toString('utf8').split(CRLF);
			
			// must have HTTP status line
			
			const match = statusLine.match(/^HTTP\/([0-9]+)\.([0-9]+) ([1-5][0-9]{2}) (.*?)$/);
			if(match === null) {
				return callback(Error('ERR_NOT_HTTP_SERVER'));
			}
			
			// HTTP version must be 1.1 or greater
			
			const httpVersionMajor = Number(match[1]);
			const httpVersionMinor = Number(match[2]);
			
			if(!(
				httpVersionMajor > 1 ||
				(httpVersionMajor === 1 && httpVersionMinor >= 1)
			)) {
				return callback(Error('ERR_HTTP_VERSION'));
			}
			
			// status code must be 101
			
			const statusCode = Number(match[3]);
			
			if(!(statusCode === STATUS_CODE_UPGRADED)) {
				return callback(Error('ERR_STATUS_CODE_NOT_UPGRADED'));
			}
			
			// parse response headers...
			
			const responseHeaders = {};
			for(let i = 0, { length } = lines; i < length; ++i) {
				const line = lines[i].trim();
				if(line === '') break;
				const indexOfColon = line.indexOf(':');
				if(indexOfColon === -1) {
					return callback(Error('ERR_HEADERS'));
				}
				const headerId = line.slice(0, indexOfColon).trim().toLowerCase();
				const headerValue = line.slice(indexOfColon + 1).trim();
				responseHeaders[headerId] = headerValue;
			}
			
			// required: upgrade: websocket
			const upgrades = getHttpHeaderAsArray(responseHeaders, 'upgrade', true);
			if(!upgrades.includes('websocket')) {
				return callback(Error('ERR_UPGRADE_HEADER'));
			}
			
			// required: connection: upgrade
			const connections = getHttpHeaderAsArray(responseHeaders, 'connection', true);
			if(!connections.includes('upgrade')) {
				return callback(Error('ERR_CONNECTION_HEADER'));
			}
			
			// required: sec-websocket-accept: magic (according to RFC-6455)
			const secWebSocketAccept = responseHeaders['sec-websocket-accept'] || '';
			if(!(secWebSocketAccept === createSHA1HashBase64(secWebSocketKey + WEB_SOCKET_GUID))) {
				return callback(Error('ERR_INVALID_ACCEPT'));
			}
			
			// optional: server may select a protocol the client sent during the handshake
			const secWebSocketProtocol = headers['sec-websocket-protocol'] || null;
			
			return callback(null, new WebSocketConnection({
				socket,
				isPeerMaskingRequired: false,
				toMaskOwnMessages: true,
			}), secWebSocketProtocol);
		}
	}
	
	function onHandshakeEnd() {
		return callback(Error('ERR_SOCKET_CLOSED_DURING_HANDSHAKE'));
	}
	
	function onHandshakeError(error) {
		return callback(error);
	}
}

function serverUpgradeRequest(request, socket, {
	selectProtocol = defaultSelectProtocol,
	headers = {},
} = {}, callback) {
	const { method, httpVersionMajor, httpVersionMinor, headers: requestHeaders } = request;
	
	// client handshake
	
	// RFC 6455 [4.1] onConnection [2] "The method of the request MUST be GET"
	if(!(method === 'GET')) {
		return callback(Error('ERR_METHOD'));
	}
	
	// RFC 6455 [4.1] onConnection [2] "the HTTP version MUST be at least 1.1"
	if(!(
		(httpVersionMajor > 1) ||
		(httpVersionMajor === 1 && httpVersionMinor >= 1)
	)) {
		return callback(Error('ERR_HTTP_VERSION'));
	}
	
	// RFC 6455 [4.1] onConnection [5] "The request MUST contain an |Upgrade| header field
	// whose value MUST include the "websocket" keyword."
	const upgrades = getHttpHeaderAsArray(requestHeaders, 'upgrade', true);
	if(!upgrades.includes('websocket')) {
		return callback(Error('ERR_UPGRADE_HEADER'));
	}
	
	// RFC 6455 [4.1] onConnection [6] "The request MUST contain a |Connection| header field
	// whose value MUST include the "Upgrade" token."
	const connections = getHttpHeaderAsArray(requestHeaders, 'connection', true);
	if(!connections.includes('upgrade')) {
		return callback(Error('ERR_CONNECTION_HEADER'));
	}
	
	// RFC 6455 [4.1] onConnection [7] The request MUST include a |Sec-WebSocket-Key| header field
	// whose value MUST be a base64-encoded 16-byte value
	const secWebSocketKey = requestHeaders['sec-websocket-key'] || '';
	if(!(
		secWebSocketKey.length === HANDSHAKE_KEY_BASE64_SIZE &&
		Buffer.from(secWebSocketKey, 'base64').byteLength === HANDSHAKE_KEY_SIZE
	)) {
		return callback(Error('ERR_WEBSOCKET_KEY'));
	}
	
	// RFC 6455 [4.1] onConnection [9] "The request MUST include a header field with the name
	// |Sec-WebSocket-Version|. The value of this header field MUST be 13."
	// (versions 9-12 were drafts, versions 8 and earlier are obsolete)
	if(!((requestHeaders['sec-websocket-version'] || '') === '13')) {
		return callback(Error('ERR_WEBSOCKET_VERSION'));
	}
	
	const secWebSocketProtocols = getHttpHeaderAsArray(requestHeaders, 'sec-websocket-protocol');
	//const secWebSocketExtensions = getHttpHeaderAsArray(headers, 'sec-websocket-extensions');
	// extensions are not supported in this implementation; TODO?
	
	selectProtocol(secWebSocketProtocols, (error, protocol) => {
		if(error) return callback(error);
		
		// server handshake
		
		const responseHeaders = Object.assign(toLowerCaseKeys(headers), {
			'upgrade': 'websocket',
			'connection': 'upgrade',
			'sec-websocket-accept': createSHA1HashBase64(secWebSocketKey + WEB_SOCKET_GUID),
		});
		if(protocol !== null) {
			responseHeaders['sec-websocket-protocol'] = protocol;
		}
		
		socket.write([
			'HTTP/1.1 ' + STATUS_CODE_UPGRADED + ' Switching Protocols',
			...serializeHttpHeaders(responseHeaders),
			CRLF,
		].join(CRLF));
		
		return callback(null, new WebSocketConnection({
			socket,
			isPeerMaskingRequired: true,
			toMaskOwnMessages: false,
		}), protocol);
	});
}

function getHttpHeaderAsArray(headers, headerId, toLowerCase = false) {
	const stringArray = (
		(headers[headerId] || '')
		.split(',')
		.map(it => it.trim())
		.filter(it => it !== '')
	);
	return toLowerCase ? stringArray.map(it => it.toLowerCase()) : stringArray;
}

function serializeHttpHeaders(headers) {
	return Object.keys(headers).map(headerId => headerId + ': ' + headers[headerId]);
}

function toLowerCaseKeys(mapObject) {
	const copy = {};
	Object.keys(mapObject).forEach(key => copy[key.toLowerCase()] = mapObject[key]);
	return copy;
}

function getBase64Length(sourceStringLength) {
	return Math.ceil(sourceStringLength / 3) * 4;
}

function defaultSelectProtocol(protocols, callback) {
	return callback(null, null);
}

function createSHA1HashBase64(data) {
	return Crypto.createHash('sha1').update(data).digest('base64');
}

function createHeaderOnlyUnmaskedFrame(opCode) {
	return Buffer.from([ (1 << 7) + opCode, 0 ]);
}

function createHeaderOnlyMaskedFrame(opCode) {
	return Buffer.from([ (1 << 7) + opCode, 1 << 7, ...Array(MASKING_KEY_SIZE).fill(0) ]);
}

function createTextFrame(string, toMask) {
	return createMessageFrame(OPCODE_TEXT_FRAME, Buffer.from(string, 'utf8'), toMask);
}

function createBinaryFrame(buffer, toMask) {
	return createMessageFrame(OPCODE_BINARY_FRAME, buffer, toMask);
}

function createCloseFrame(code = 1005, toMask) {
	return createMessageFrame(OPCODE_CONNECTION_CLOSE, Buffer.from(code.toString()), toMask);
}

function createMessageFrame(opCode, payload, toMask) {
	const length = payload.byteLength;
	
	let header = null;
	if(length < 126) {
		header = Buffer.allocUnsafe(2 + 0);
		header[1] = length;
	} else if(length < (2 ** 16)) {
		header = Buffer.allocUnsafe(2 + 2);
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.allocUnsafe(2 + 8);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	header[0] = (1 << 7) + opCode;
	
	if(toMask) {
		const maskingKey = Crypto.randomBytes(MASKING_KEY_SIZE);
		payload = Buffer.from(payload); // copy to avoid corrupting original data
		for(let i = 0; i < length; ++i) {
			payload[i] = payload[i] ^ maskingKey[i % MASKING_KEY_SIZE];
		}
		header[1] |= (1 << 7);
		return Buffer.concat([ header, maskingKey, payload ]);
	}
	
	return Buffer.concat([ header, payload ]);
}

function WebSocketConnection({
	socket,
	isPeerMaskingRequired = true,
	toMaskOwnMessages = true,
}) {
	
	// state.public-write
	
	// event callbacks
	let onTextMessage = null;
	let onBinaryMessage = null;
	let onSync = null;
	let onEnd = null;
	
	// state.public-read
	
	// exchange status
	let isAlive = true; // true until connection dropout for any reason
	let lastSyncDate = new Date(); // update per data frame from client for keep-alive status
	
	// state.internal
	
	// ping pong cache
	const frameDataPing = toMaskOwnMessages ? FRAME_DATA_PING_MASKED : FRAME_DATA_PING_UNMASKED;
	const frameDataPong = toMaskOwnMessages ? FRAME_DATA_PONG_MASKED : FRAME_DATA_PONG_UNMASKED;
	
	// client communication status
	let isReadingMessage = false; // handle multi-frame messages (first-frame-not-FIN-1)
	
	// frame state: has to be in upper scope to handle data stream buffered chunks
	let isFinSet = false; // updates per frame
	let isMasked = false; // updates per start frame
	let payloadOpCode = 0x0; // updates per start frame
	let maskingKey = null; // updates per start frame
	let maskingIndex = 0; // updates per frame with payload
	let remainingLength = 0; // updates per frame with payload
	
	// handles both multi-frame messages chunks and data stream buffered chunks
	const payloadBuffers = []; // output buffer
	
	// run
	
	socket.on('data', onData);
	socket.on('end', () => { dropConnection(1000, 'CONNECTION_CLOSED'); });
	socket.on('close', () => { dropConnection(1000, 'CONNECTION_CLOSED'); });
	socket.on('error', error => { dropConnection(1011, 'NETWORK_ERROR', error); });
	socket.on('timeout', () => { dropConnection(1008, 'TIMEOUT'); });
	
	// public
	
	Object.assign(this, {
		// action-close
		end: () => { dropConnection(1000, 'CLOSED_BY_SELF'); },
		
		// action-write
		sendTextMessage,
		sendBinaryMessage,
		sendPing,
		
		// setters-events
		setOnTextMessage: it => onTextMessage = it,
		setOnBinaryMessage: it => onBinaryMessage = it,
		setOnSync: it => onSync = it,
		setOnEnd: it => onEnd = it,
		
		// getters-state
		isOpen: () => isAlive,
		getLastSyncDate: () => lastSyncDate,
	});
	
	// functions.public
	
	function sendTextMessage(string) {
		socket.write(createTextFrame(string, toMaskOwnMessages));
	}
	
	function sendBinaryMessage(buffer) {
		socket.write(createBinaryFrame(buffer, toMaskOwnMessages));
	}
	
	function sendPing() {
		socket.write(frameDataPing);
	}
	
	function sendPong() {
		socket.write(frameDataPong);
	}
	
	// functions.events
	
	function onData(buffer) {
		lastSyncDate = new Date();
		if(onSync !== null) {
			onSync(lastSyncDate);
		}
		
		if(remainingLength === 0) {
			readDataFrameHeader(buffer);
		} else {
			readDataFramePayload(buffer);
		}
	}
	
	// functions.internal
	
	function readDataFrameHeader(buffer) {
		const { byteLength: length } = buffer;
		
		// ensure sent buffer has enough bytes to read from
		let minLength = 2;
		if(length < minLength) return dropConnection(1002, 'ERR_INAVLID_DATA_FRAME_H2');
		
		// fin, rsv, opcode
		const byte0 = buffer[0];
		
		isFinSet = (byte0 & (1 << 7)) !== 0;
		const isRSV1Set = (byte0 & (1 << 6)) !== 0;
		const isRSV2Set = (byte0 & (1 << 5)) !== 0;
		const isRSV3Set = (byte0 & (1 << 4)) !== 0;
		
		// no extension support
		if(isRSV1Set || isRSV2Set || isRSV3Set) return dropConnection(1003, 'INVALID_EXTENSION');
		
		const opCode = byte0 & ((1 << 4) - 1);
		
		// mask, payload length
		const byte1 = buffer[1];
		
		isMasked = (byte1 & (1 << 7)) !== 0;
		
		// if client messages have to be masked, enforce
		if(isPeerMaskingRequired && !isMasked) {
			return dropConnection(1008, 'ERR_PEER_MASKING_DISABLED');
		}
		
		const payloadLength7 = byte1 & ((1 << 7) - 1);
		
		// extended payload length: +0 | +2 | +8 bytes
		
		let payloadLength = 0;
		let nextBufferIndex = 2;
		switch(payloadLength7) {
			case 126:
				minLength += 2;
				if(length < minLength) return dropConnection(1002, 'ERR_INAVLID_DATA_FRAME_P16');
				payloadLength = buffer.readUInt16BE(nextBufferIndex);
				nextBufferIndex += 2;
				break;
			case 127:
				minLength += 8;
				if(length < minLength) return dropConnection(1002, 'ERR_INAVLID_DATA_FRAME_P64');
				payloadLength = Number(buffer.readBigUInt64BE(nextBufferIndex));
				nextBufferIndex += 8;
				break;
			default:
				payloadLength = payloadLength7;
		}
		
		if(isMasked) {
			
			// +4 bytes for masking key
			
			minLength += MASKING_KEY_SIZE;
			if(length < minLength) return dropConnection(1002, 'ERR_MASKING_KEY_MISSING');
			
			maskingKey = Buffer.from(buffer.slice(
				nextBufferIndex,
				nextBufferIndex + MASKING_KEY_SIZE
			));
			nextBufferIndex += MASKING_KEY_SIZE;
		}
		
		switch(opCode) {
			case OPCODE_CONNECTION_CLOSE:
				return dropConnection(1000, 'CLOSED_BY_PEER');
			case OPCODE_CONTINUATION_FRAME:
				if(!isReadingMessage) return dropConnection(1002, 'ERR_BAD_CONTINUE_OPCODE');
				break;
			case OPCODE_TEXT_FRAME:
			case OPCODE_BINARY_FRAME:
				if(isReadingMessage) return dropConnection(1002, 'ERR_BAD_DATA_OPCODE');
				isReadingMessage = true;
				payloadOpCode = opCode;
				payloadBuffers.length = 0; // this line is probably not really needed (check)
				break;
			case OPCODE_PING:
				return sendPong();
			case OPCODE_PONG:
				return; // do nothing, the purpose of this frame was to just update lastSyncDate
			default:
				return dropConnection(1003, 'ERR_UNSUPPORTED_OPCODE');
		}
		
		maskingIndex = 0;
		remainingLength = payloadLength;
		
		readDataFramePayload(buffer.slice(nextBufferIndex));
	}
	
	function readDataFramePayload(buffer) {
		const { byteLength } = buffer;
		
		const length = Math.min(byteLength, remainingLength);
		
		if(isMasked) {
			for(let i = 0; i < length; ++i) {
				buffer[i] = buffer[i] ^ maskingKey[maskingIndex]; // unmask payload in-place
				maskingIndex = (maskingIndex + 1) % MASKING_KEY_SIZE;
			}
		}
		payloadBuffers.push(buffer.slice(0, length));
		remainingLength -= length;
		
		if(remainingLength === 0) {
			if(isFinSet) {
				maskingKey = null; // free memory
				onFrameComplete();
			}
			if(byteLength > length) {
				readDataFrameHeader(buffer.slice(length));
			}
		}
	}
	
	function onFrameComplete() {
		isReadingMessage = false;
		
		let callback = null;
		let data = null;
		switch(payloadOpCode) {
			case OPCODE_BINARY_FRAME:
				if(onBinaryMessage !== null) {
					callback = onBinaryMessage;
					data = Buffer.concat(payloadBuffers);
				}
				break;
			case OPCODE_TEXT_FRAME:
				if(onTextMessage !== null) {
					callback = onTextMessage;
					data = Buffer.concat(payloadBuffers).toString('utf8');
				}
				break;
		}
		payloadBuffers.length = 0; // free memory
		
		if(callback !== null) {
			return callback(data);
		}
	}
	
	function dropConnection(statusCode, appCode, error = null) {
		if(!isAlive) return;
		isAlive = false;
		
		socket.write(createCloseFrame(statusCode, toMaskOwnMessages));
		socket.end();
		
		if(onEnd !== null) {
			onEnd(appCode, statusCode, error);
		}
	}
}
