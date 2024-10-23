import express from 'express';
import schedule from 'node-schedule';
import { getCombinedNBAGames, checkHalftimeStatus, aggregateGameData, predict, fetchEndGameStats } from './nbaUtils.js';
import { createObjectCsvWriter } from 'csv-writer';
import moment from 'moment-timezone';
const app = express();
const port = process.env.PORT || 3001;
// Import the whole package as a single module
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    user: process.env.RDS_USERNAME,
    host: process.env.RDS_HOSTNAME,
    database: process.env.RDS_DB_NAME,
    password: process.env.RDS_PASSWORD,
    port: process.env.RDS_PORT,
    ssl: {
        rejectUnauthorized: false, // This bypasses the certificate verification. For production, you should have a valid CA.
        // If you have CA file: ca: fs.readFileSync("/path/to/server-certificates/root.crt").toString(),
      }
  });
pool.on('connect', () => {
  console.log('Connected to the database');
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
//second
// Route to get all combined NBA games
app.get('/nba/games', async (req, res) => {
    try {
        const games = await getCombinedNBAGames();
        res.status(200).json(games);
    } catch (error) {
        console.error("Failed to fetch NBA games:", error);
        res.status(500).send("Failed to fetch NBA games");
    }
});

app.get('/get-all-rows', async (req, res) => {
    try {
        const query = 'SELECT * FROM selected';
        const { rows } = await pool.query(query);
        let responseText = rows.map(row => 
            `id: ${row.id}, game: ${row.game}, date: ${row.date}, player: ${row.player}, current_points: ${row.current_points}, line: ${row.line}, difference: ${row.difference}, odds: ${row.odds}, hit: ${row.hit}`
        ).join('\n');
        res.type('text/plain').send(responseText); // Send the response in plain text format
    } catch (error) {
        console.error('Failed to fetch rows:', error);
        res.status(500).send('Failed to fetch rows from the database');
    }
});


// Route to get player prop odds for a specific game
app.get('/nba/odds/:dkGameId', async (req, res) => {
    const { dkGameId } = req.params;
    try {
        const odds = await getNBAGamePlayerProps(dkGameId);
        if (odds) {
            res.status(200).json(odds);
        } else {
            res.status(404).send("No odds available for this game ID");
        }
    } catch (error) {
        console.error(`Failed to fetch odds for game ID ${dkGameId}:`, error);
        res.status(500).send("Failed to fetch odds");
    }
});

// Route to get live box score for a specific game
app.get('/nba/stats/:gameId', async (req, res) => {
    const { gameId } = req.params;
    try {
        const stats = await fetchPlayerStatsForGame(gameId);
        if (stats && stats.length > 0) {
            res.status(200).json(stats);
        } else {
            res.status(404).send("No stats available for this game ID");
        }
    } catch (error) {
        console.error(`Failed to fetch player stats for game ${gameId}:`, error);
        res.status(500).send("Failed to fetch player stats");
    }
});

/**
 * Schedule game checks to start at 7 PM EST every day.
 * Note: '0 16 * * *' runs at 16:00 UTC, which is 12:00 PM EST. Adjust according to daylight saving time.
 */
schedule.scheduleJob('21 00 * * *', function() {
    console.log(`${new Date().toISOString()} - Setting up game checks...`);
    setupGameChecks();
});

// Route to get live box score for a specific game
app.get('/setup', async (req, res) => {
    console.log(`${new Date().toISOString()} - Setting up game checks...`);
    setupGameChecks();
    res.send("Game checks set up")
});

/**
 * Sets up initial checks for all games fetched for the day.
 */
async function setupGameChecks() {
    try {
        const games = await getCombinedNBAGames();
        games.forEach(game => {
            scheduleInitialHalftimeCheck(game);
            scheduleEndGameCheck(game)
        });
    } catch (error) {
        console.error("Error setting up game checks:", error);
    }
}

function scheduleEndGameCheck(game) {
    const gameDateTimeString = `${game.date}T${game.time}:00`; // Assuming this is correct
    const gameDateTime = moment.tz(gameDateTimeString, "America/New_York").toDate(); // Convert local time to Date object
    const threeHoursLater = new Date(gameDateTime.getTime() + 3 * 3600 * 1000); // 3 hours later in UTC

    schedule.scheduleJob(threeHoursLater, function() {
        console.log(`Running end-game check for game ${game.gameId}...`);
        performEndGameCheck(game); // Pass the game object
    });
}
async function performEndGameCheck(game) {
    const gameDescription = `${game.homeTeam} vs ${game.awayTeam}`;
    const playerStats = await fetchEndGameStats(game.gameId); // Fetches updated stats
    const bets = await fetchStoredBets(gameDescription); // Fetch bets using game description

    for (const bet of bets) {
        const playerStat = playerStats.find(p => p.PlayerName === bet.player);
        let hitStatus = false; // Default to false

        if (playerStat) {
            hitStatus = playerStat.Points >= bet.line;
        } else {
            console.warn(`No stats found for player ${bet.player} in game ${gameDescription}`);
            // You can decide whether to set hitStatus to false or leave it as NULL
        }

        // Update the hit status in the database
        await updateHitStatus(bet.id, hitStatus);
    }
}

/**
 * Schedules the initial halftime check for one hour after the game starts.
 */
 function scheduleInitialHalftimeCheck(game) {
    // Assuming game.time includes properly formatted HH:mm time
    // and game.date includes the YYYY-MM-DD format
    const gameDateTimeString = `${game.date}T${game.time}:00`; // Appending ':00' assuming time is in HH:mm format
    const gameDateTime = moment.tz(gameDateTimeString, "YYYY-MM-DDTHH:mm:ss", "America/New_York").toDate(); // Convert local time to Date object

    // Calculate one hour after game start time
    const oneHourLater = new Date(gameDateTime.getTime() + 3600000); // 1 hour later in UTC

    schedule.scheduleJob(oneHourLater, function() {
        console.log(`Checking for halftime status of game ${game.gameId} at ${oneHourLater}...`);
        checkAndRepeatHalftime(game);
    });
}


async function checkAndRepeatHalftime(game) {
    const isHalftime = await checkHalftimeStatus(game.gameId);
    if (!isHalftime) {
        console.log(`Not halftime yet for game ${game.gameId}, will check again in 5 minutes.`);
        const jobId = `check-halftime-${game.gameId}`;
        const fiveMinutesLater = new Date(new Date().getTime() + 300000); // 5 minutes from now

        const existingJob = schedule.scheduledJobs[jobId];
        if (existingJob) {
            existingJob.cancel();
        }

        schedule.scheduleJob(jobId, fiveMinutesLater, () => checkAndRepeatHalftime(game));
    } else {
        console.log(`It's halftime for game ${game.gameId}. Proceeding with data aggregation...`);
        aggregateGameData(game.gameId).then(gameData => {
            if(gameData){
                predictAndWriteToDatabase(gameData);
            }
        });
        
    }
}
async function fetchStoredBets(gameDescription) {
    const query = 'SELECT id, player, line FROM selected WHERE game = $1 AND hit IS NULL';
    const { rows } = await pool.query(query, [gameDescription]);
    return rows;
}

async function updateHitStatus(betId, hitStatus) {
    const query = 'UPDATE selected SET hit = $1 WHERE id = $2';
    await pool.query(query, [hitStatus, betId]);
    console.log(`Updated hit status for bet ID ${betId} to ${hitStatus}`);
}


async function predictAndWriteToDatabase(gameData) {
    const selectedBets = await predict(gameData.gameId);
    if (selectedBets.length > 0) {
        console.log(`Home Team: ${gameData.homeTeam}, Away Team: ${gameData.awayTeam}`);
        writeToDatabase(selectedBets, gameData.homeTeam, gameData.awayTeam, String(gameData.date));
    } else {
        console.log(`No bets selected for game ${gameData.homeTeam} vs ${gameData.awayTeam}`);
    }
}

async function writeToDatabase(selectedBets, homeTeam, awayTeam, gameDate) {
    const query = `
    INSERT INTO selected (game, date, player, current_points, line, difference, odds, hit)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`;

    try {
        await Promise.all(selectedBets.map(bet => {
            const game = `${homeTeam} vs ${awayTeam}`;
            return pool.query(query, [
                game,
                gameDate,
                bet.PlayerName,
                bet.CurrentPoints,
                bet.Line,
                bet.DifferenceNeeded,
                bet.Odds,
                null // Set 'hit' to NULL
            ]);
        }));
        console.log(`Data has been written to the database for game ${homeTeam} vs ${awayTeam}.`);
    } catch (err) {
        console.error('Error writing to database:', err);
    }
}
