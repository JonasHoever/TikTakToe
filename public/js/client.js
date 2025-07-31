const socket = new WebSocket('wss://jonashoever.de:3000'); // Stelle sicher, dass der Port übereinstimmt!

// --- DOM-Elemente ---
const createCustomGameBtn = document.getElementById('createCustomGameBtn');
const joinCustomGameBtn = document.getElementById('joinCustomGameBtn');
const gameIdInput = document.getElementById('gameIdInput');
const gameSetupDiv = document.getElementById('game-setup');
const gameInfoP = document.getElementById('gameInfo');
const gameBoardDiv = document.getElementById('game-board');
const cells = document.querySelectorAll('.cell');
const statusMessage = document.getElementById('status-message');
const newGameBtn = document.getElementById('newGameBtn');
const availableGamesList = document.getElementById('availableGamesList');
const gameAreaDiv = document.getElementById('game-area');
const leaveGameBtn = document.getElementById('leaveGameBtn');
const joinMatchmakingBtn = document.getElementById('joinMatchmakingBtn');
const cancelMatchmakingBtn = document.getElementById('cancelMatchmakingBtn');
const matchmakingStatusDiv = document.getElementById('matchmaking-status');
const rematchBtn = document.getElementById('rematchBtn');

// --- Spielzustandsvariablen (lokal gespeichert) ---
let myGameId = sessionStorage.getItem('myGameId') || null;
let myPlayerId = sessionStorage.getItem('myPlayerId') || null;
let myPlayerSymbol = null; // Wichtig: Symbol des aktuellen Spielers
let currentBoard = Array(9).fill(null);
let currentTurn = null;
let gameStatus = 'initial'; // 'initial', 'waiting', 'playing', 'finished', 'disconnected', 'queued'
let isInMatchmakingQueue = false;

// --- WebSocket-Event-Handler ---

socket.onopen = function(event) {
    console.log('WebSocket connection opened:', event);
    // Wenn keine PlayerId vorhanden ist, generieren wir eine neue für diese Session
    if (!myPlayerId) {
        myPlayerId = 'player_' + Math.random().toString(36).substring(2, 10);
        sessionStorage.setItem('myPlayerId', myPlayerId);
        console.log(`Generated new Player ID: ${myPlayerId}`);
    }

    if (myGameId) {
        // Wenn IDs im Session Storage gefunden wurden, versuche einen Reconnect
        statusMessage.innerText = 'Versuche, mich wieder mit deinem Spiel zu verbinden...';
        // Für Reconnects immer `joinGame` verwenden, der Server handhabt dann, ob es ein Custom- oder Matchmaking-Spiel war.
        socket.send(JSON.stringify({ type: 'joinGame', gameId: myGameId, playerId: myPlayerId }));
        // Anzeige-Logik wird vom Server-Response gesteuert
        // Temporär anzeigen, dass etwas passiert
        gameSetupDiv.style.display = 'none';
        gameAreaDiv.style.display = 'block';
        matchmakingStatusDiv.style.display = 'none';
    } else {
        // Andernfalls zeige das Setup und fordere die Lobby an
        showGameSetup();
        socket.send(JSON.stringify({ type: 'requestLobby' }));
    }
};

socket.onmessage = function(event) {
    const data = JSON.parse(event.data);
    console.log('Message from server:', data);

    switch (data.type) {
        case 'gameCreated': // Für Custom Games
            myGameId = data.gameId;
            myPlayerId = data.playerId;
            myPlayerSymbol = data.symbol; // Server sendet 'X'
            sessionStorage.setItem('myGameId', myGameId);
            sessionStorage.setItem('myPlayerId', myPlayerId);

            gameInfoP.innerText = `Privates Spiel erstellt! Teile diese ID: ${myGameId.substring(5)}. Du bist ${myPlayerSymbol}.`;
            statusMessage.innerText = 'Warte auf Gegner...';
            gameStatus = 'waiting';
            currentTurn = 'X'; // Der Ersteller ist immer 'X' und beginnt
            showGameArea();
            renderBoard();
            break;

        case 'gameJoined': // Für Custom Games (wenn man selbst beitritt)
            myGameId = data.gameId;
            myPlayerSymbol = data.symbol; // Server sendet 'O'
            sessionStorage.setItem('myGameId', myGameId);
            sessionStorage.setItem('myPlayerId', myPlayerId);

            gameInfoP.innerText = `Dem privaten Spiel ${myGameId.substring(5)} beigetreten. Du bist ${myPlayerSymbol}.`;
            currentBoard = data.board;
            currentTurn = data.turn;
            gameStatus = data.status;
            showGameArea();
            updateStatusMessage(); // Wichtig, um den Status sofort zu aktualisieren
            renderBoard();
            break;

        case 'opponentJoined': // Wenn ein Gegner einem Custom Game beitritt (man war der Ersteller)
            currentBoard = data.board;
            currentTurn = data.turn;
            gameStatus = data.status;
            gameInfoP.innerText = `Dem privaten Spiel ${myGameId.substring(5)} beigetreten. Du bist ${myPlayerSymbol}.`; // Info aktualisieren, um klarzustellen, dass man X ist
            showGameArea(); // Sicherstellen, dass die Game Area sichtbar ist
            updateStatusMessage(); // Wichtig: Status aktualisieren, um richtigen Zug anzuzeigen
            renderBoard();
            break;

        case 'matchmakingQueued': // Wenn man in die Matchmaking-Warteschlange aufgenommen wird
            isInMatchmakingQueue = true;
            statusMessage.innerText = data.message;
            statusMessage.classList.add('waiting');
            showMatchmakingStatus();
            break;

        case 'matchmakingCancelled': // Wenn man Matchmaking abbricht
            isInMatchmakingQueue = false;
            statusMessage.innerText = data.message;
            statusMessage.classList.remove('waiting');
            showGameSetup(); // Zurück zum Setup
            socket.send(JSON.stringify({ type: 'requestLobby' })); // Lobby aktualisieren
            break;

        case 'matchFound': // Wenn ein Matchmaking-Spiel gefunden wird
            isInMatchmakingQueue = false;
            myGameId = data.gameId;
            myPlayerSymbol = data.symbol; // Server sendet korrekt 'X' oder 'O'
            currentBoard = data.board;
            currentTurn = data.turn;
            gameStatus = 'playing';
            sessionStorage.setItem('myGameId', myGameId); // Speichern für Reconnect
            sessionStorage.setItem('myPlayerId', myPlayerId);

            gameInfoP.innerText = `Matchmaking-Spiel gefunden! Du bist ${myPlayerSymbol}.`;
            showGameArea();
            updateStatusMessage(); // Wichtig: Status aktualisieren, um richtigen Zug anzuzeigen
            renderBoard();
            break;

        case 'reconnected':
            myGameId = data.gameId;
            myPlayerSymbol = data.symbol; // Wichtig: eigenes Symbol vom Server erhalten
            currentBoard = data.board;
            currentTurn = data.turn;
            gameStatus = data.status;
            gameInfoP.innerText = `Erfolgreich mit Spiel ${myGameId.substring(5)} verbunden. Du bist ${myPlayerSymbol}.`;
            showGameArea();
            updateStatusMessage();
            renderBoard();
            if (gameStatus === 'finished') {
                newGameBtn.style.display = 'block';
                rematchBtn.style.display = 'block';
                rematchBtn.innerText = 'Revanche!'; // Rematch-Button zurücksetzen
                rematchBtn.disabled = false;
            } else {
                newGameBtn.style.display = 'none';
                rematchBtn.style.display = 'none';
            }
            break;

        case 'gameState':
            currentBoard = data.board;
            currentTurn = data.turn;
            gameStatus = data.status || 'playing';
            renderBoard();
            updateStatusMessage();
            newGameBtn.style.display = 'none';
            rematchBtn.style.display = 'none'; // Verstecke Rematch-Button, wenn Spiel aktiv
            break;

        case 'gameOver':
            currentBoard = data.board;
            renderBoard();
            gameStatus = 'finished';
            if (data.winner === 'draw') {
                statusMessage.innerText = 'Unentschieden!';
            } else {
                statusMessage.innerText = `🎉 Spiel vorbei! Gewinner: Spieler ${data.winner}! 🎉`;
            }
            newGameBtn.style.display = 'block';
            rematchBtn.style.display = 'block'; // Zeige Rematch-Button nach Spielende
            rematchBtn.innerText = 'Revanche!'; // Text zurücksetzen
            rematchBtn.disabled = false; // Aktivieren
            sessionStorage.removeItem('myGameId'); // Spiel beendet, Session-Info für GameId löschen
            break;

        case 'opponentDisconnected':
            statusMessage.innerText = 'Dein Gegner hat die Verbindung verloren. Du kannst ein neues Spiel starten.';
            gameStatus = 'disconnected';
            newGameBtn.style.display = 'block';
            leaveGameBtn.style.display = 'none';
            rematchBtn.style.display = 'none';
            sessionStorage.removeItem('myGameId'); // Spiel ist "kaputt", alte ID löschen
            break;

        case 'opponentReconnected':
            statusMessage.innerText = 'Dein Gegner ist wieder verbunden!';
            if (gameStatus === 'disconnected') { // Falls der Status zuvor disconnected war
                 gameStatus = 'playing';
            }
            updateStatusMessage();
            newGameBtn.style.display = 'none';
            rematchBtn.style.display = 'none';
            break;

        case 'opponentLeft': // Wenn der Gegner das Custom Game über den Leave-Button verlassen hat
            statusMessage.innerText = data.message;
            gameStatus = 'waiting'; // Das Custom Game ist jetzt wieder im Wartezustand
            newGameBtn.style.display = 'block';
            leaveGameBtn.style.display = 'none';
            rematchBtn.style.display = 'none';
            sessionStorage.removeItem('myGameId'); // Spiel ist in "Lobby-Modus" zurück
            socket.send(JSON.stringify({ type: 'requestLobby' })); // Lobby aktualisieren
            break;

        case 'lobbyUpdate': // Lobby-Informationen vom Server erhalten
            renderLobby(data.games);
            break;

        case 'gameLeft': // Bestätigung vom Server, dass man das Spiel verlassen hat
            console.log(data.message);
            myGameId = null; // Wichtig: myGameId löschen
            sessionStorage.removeItem('myGameId');
            showGameSetup();
            socket.send(JSON.stringify({ type: 'requestLobby' })); // Lobby erneut anfordern
            break;

        case 'rematchOffered': // Wenn der Gegner eine Revanche anbietet
            statusMessage.innerText = 'Dein Gegner möchte eine Revanche!';
            rematchBtn.innerText = 'Revanche annehmen';
            rematchBtn.classList.add('rematch-pending'); // Stil ändern
            rematchBtn.disabled = false; // Sicherstellen, dass Button aktiv ist
            rematchBtn.onclick = () => {
                socket.send(JSON.stringify({ type: 'rematchRequest', gameId: myGameId, playerId: myPlayerId }));
                rematchBtn.innerText = 'Warte auf Gegner...';
                rematchBtn.disabled = true;
            };
            break;

        case 'rematchAccepted': // Wenn die Revanche gestartet wird
            myGameId = data.gameId;
            myPlayerSymbol = data.symbol; // Wichtig: eigenes neues Symbol vom Server erhalten
            currentBoard = data.board;
            currentTurn = data.turn;
            gameStatus = 'playing';
            sessionStorage.setItem('myGameId', myGameId); // Neue GameId speichern
            // Player ID bleibt gleich

            gameInfoP.innerText = `Revanche! Du bist ${myPlayerSymbol}. Spiel-ID: ${myGameId.substring(5)}`;
            showGameArea();
            updateStatusMessage();
            renderBoard();
            rematchBtn.style.display = 'none'; // Rematch-Button ausblenden
            rematchBtn.innerText = 'Revanche!'; // Button-Text zurücksetzen für das nächste Mal
            rematchBtn.classList.remove('rematch-pending');
            newGameBtn.style.display = 'none';
            leaveGameBtn.style.display = 'block';
            break;

        case 'error':
            alert('Fehler: ' + data.message);
            console.error('Server error:', data.message);
            // Bei kritischen Fehlern den Zustand zurücksetzen
            if (data.message.includes('Game not found') || data.message.includes('Game is full') || data.message.includes('Invalid message format') || data.message.includes('already in an active game') || data.message.includes('Matchmaking failed') || data.message.includes('Not in a game')) {
                // Nur myGameId zurücksetzen, damit PlayerId für zukünftige Spiele bleibt
                sessionStorage.removeItem('myGameId');
                myGameId = null;
                showGameSetup(); // Zurück zum Hauptbildschirm
                socket.send(JSON.stringify({ type: 'requestLobby' })); // Lobby erneut anfordern
            }
            // Wenn man in der Queue war und ein Fehler auftritt, Queue-Status zurücksetzen
            if (isInMatchmakingQueue) {
                isInMatchmakingQueue = false;
                statusMessage.innerText = '';
                showGameSetup();
            }
            break;
    }
};

socket.onclose = function(event) {
    console.log('WebSocket connection closed:', event);
    if (gameStatus !== 'finished' && gameStatus !== 'disconnected' && gameStatus !== 'leaving') {
         statusMessage.innerText = 'Verbindung zum Server verloren. Bitte Seite neu laden.';
         gameStatus = 'disconnected';
         showGameArea(); // Zeigt Game Area mit Fehlermeldung
         newGameBtn.style.display = 'block';
         leaveGameBtn.style.display = 'none';
         rematchBtn.style.display = 'none';
         sessionStorage.removeItem('myGameId'); // Alte GameId ungültig
    }
    // Matchmaking-Status zurücksetzen
    isInMatchmakingQueue = false;
    matchmakingStatusDiv.style.display = 'none';
};

socket.onerror = function(error) {
    console.error('WebSocket error:', error);
    statusMessage.innerText = 'Ein kritischer Fehler ist aufgetreten. Bitte Seite neu laden.';
    gameStatus = 'disconnected';
    showGameArea();
    newGameBtn.style.display = 'block';
    leaveGameBtn.style.display = 'none';
    rematchBtn.style.display = 'none';
    sessionStorage.removeItem('myGameId');
    isInMatchmakingQueue = false;
    matchmakingStatusDiv.style.display = 'none';
};

// --- UI-Steuerung Funktionen ---
function showGameSetup() {
    gameSetupDiv.style.display = 'block';
    gameAreaDiv.style.display = 'none';
    matchmakingStatusDiv.style.display = 'none';
    // Buttons für Game-Area ausblenden
    newGameBtn.style.display = 'none';
    leaveGameBtn.style.display = 'none';
    rematchBtn.style.display = 'none';
    rematchBtn.innerText = 'Revanche!'; // Text zurücksetzen
    rematchBtn.classList.remove('rematch-pending'); // Klasse entfernen
    rematchBtn.disabled = false; // Aktivieren
    gameInfoP.innerText = ''; // Game Info leeren
    statusMessage.innerText = ''; // Status Message leeren
    renderBoard(Array(9).fill(null)); // Board leeren
}

function showGameArea() {
    gameSetupDiv.style.display = 'none';
    gameAreaDiv.style.display = 'block';
    matchmakingStatusDiv.style.display = 'none';
    newGameBtn.style.display = 'none'; // Initial ausblenden, wird durch Game Over wieder gezeigt
    leaveGameBtn.style.display = 'block'; // Erlaube Verlassen während des Spiels
    rematchBtn.style.display = 'none'; // Initial ausblenden, wird nach Game Over gezeigt
}

function showMatchmakingStatus() {
    gameSetupDiv.style.display = 'none';
    gameAreaDiv.style.display = 'none';
    matchmakingStatusDiv.style.display = 'flex'; // Flex, um Inhalt zu zentrieren
    // Buttons für Game-Area ausblenden
    newGameBtn.style.display = 'none';
    leaveGameBtn.style.display = 'none';
    rematchBtn.style.display = 'none';
}

// --- Event Listener ---

createCustomGameBtn.addEventListener('click', () => {
    socket.send(JSON.stringify({ type: 'createGame', playerId: myPlayerId }));
    gameIdInput.value = '';
});

joinCustomGameBtn.addEventListener('click', () => {
    const gameId = gameIdInput.value.trim();
    if (gameId) {
        socket.send(JSON.stringify({ type: 'joinGame', gameId: `game_${gameId}`, playerId: myPlayerId }));
    } else {
        alert('Bitte gib eine Spiel-ID ein.');
    }
});

joinMatchmakingBtn.addEventListener('click', () => {
    if (!isInMatchmakingQueue) {
        socket.send(JSON.stringify({ type: 'requestMatchmaking', playerId: myPlayerId }));
    } else {
        alert('Du bist bereits in der Matchmaking-Warteschlange!');
    }
});

cancelMatchmakingBtn.addEventListener('click', () => {
    if (isInMatchmakingQueue) {
        socket.send(JSON.stringify({ type: 'cancelMatchmaking', playerId: myPlayerId }));
    }
});

cells.forEach(cell => {
    cell.addEventListener('click', () => {
        const index = parseInt(cell.dataset.index);
        if (gameStatus === 'playing' && myPlayerSymbol === currentTurn && currentBoard[index] === null) {
            socket.send(JSON.stringify({ type: 'makeMove', index: index }));
        } else if (gameStatus !== 'playing') {
            statusMessage.innerText = 'Das Spiel ist noch nicht gestartet oder beendet.';
        } else if (myPlayerSymbol !== currentTurn) {
            statusMessage.innerText = 'Du bist nicht am Zug!';
        } else if (currentBoard[index] !== null) {
            statusMessage.innerText = 'Dieses Feld ist bereits belegt.';
        }
    });
});

newGameBtn.addEventListener('click', () => {
    // Löscht die Session-Infos und lädt die Seite neu, um einen Neuanfang zu ermöglichen
    sessionStorage.removeItem('myGameId');
    myGameId = null;
    location.reload();
});

leaveGameBtn.addEventListener('click', () => {
    if (confirm('Bist du sicher, dass du das Spiel verlassen möchtest?')) {
        socket.send(JSON.stringify({ type: 'leaveGame', gameId: myGameId, playerId: myPlayerId }));
        gameStatus = 'leaving'; // Temporären Status setzen, damit onclose nicht wieder triggert
        sessionStorage.removeItem('myGameId'); // Alte GameId entfernen, um neues Spiel zu ermöglichen
        myGameId = null;
    }
});

rematchBtn.addEventListener('click', () => {
    socket.send(JSON.stringify({ type: 'rematchRequest', gameId: myGameId, playerId: myPlayerId }));
    rematchBtn.innerText = 'Warte auf Gegner...';
    rematchBtn.disabled = true; // Button deaktivieren, um Mehrfach-Klicks zu vermeiden
});

// --- UI-Rendering Funktionen ---

function renderBoard() {
    cells.forEach((cell, index) => {
        cell.innerText = currentBoard[index];
        cell.classList.remove('x', 'o'); // Alte Klassen entfernen
        if (currentBoard[index]) {
            cell.classList.add(currentBoard[index].toLowerCase());
        }
    });
}

function updateStatusMessage() {
    statusMessage.className = 'status-message'; // Setze eine Standardklasse zurück

    if (gameStatus === 'playing') {
        if (myPlayerSymbol === currentTurn) {
            statusMessage.innerText = `Du bist am Zug (${myPlayerSymbol}).`;
            statusMessage.classList.add('your-turn');
        } else {
            statusMessage.innerText = `Warte auf den Zug deines Gegners (${currentTurn}).`;
            statusMessage.classList.add('opponent-turn');
        }
    } else if (gameStatus === 'waiting') {
        statusMessage.innerText = 'Warte auf den zweiten Spieler...';
        statusMessage.classList.add('waiting');
    } else if (gameStatus === 'finished') {
        // Nachricht wird direkt von `gameOver` gesetzt
        statusMessage.classList.add('game-over');
    } else if (gameStatus === 'disconnected') {
        // Nachricht wird direkt von `opponentDisconnected` oder `socket.onclose` gesetzt
        statusMessage.classList.add('disconnected');
    }
}

function renderLobby(games) {
    availableGamesList.innerHTML = ''; // Liste leeren
    if (games.length === 0) {
        availableGamesList.innerHTML = '<li>Derzeit keine offenen privaten Spiele. Erstelle ein neues!</li>';
    } else {
        games.forEach(game => {
            const li = document.createElement('li');
            li.classList.add('game-item');

            const gameIdDisplay = game.gameId.substring(5); // Zeigt nur den Zähler an (z.B. "0", "1")
            const creatorDisplay = game.creatorId ? game.creatorId.substring(0, 5) + '...' : 'Unbekannt';

            const infoSpan = document.createElement('span');
            infoSpan.innerText = `Spiel #${gameIdDisplay} (Ersteller: ${creatorDisplay})`;

            const joinButton = document.createElement('button');
            joinButton.innerText = `Beitreten`;
            joinButton.classList.add('btn', 'join-lobby-btn');
            joinButton.addEventListener('click', () => {
                socket.send(JSON.stringify({ type: 'joinGame', gameId: game.gameId, playerId: myPlayerId }));
            });

            li.appendChild(infoSpan);
            li.appendChild(joinButton);
            availableGamesList.appendChild(li);
        });
    }
}