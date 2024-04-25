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

app.get('/print-all-rows', async (req, res) => {
    try {
        const query = 'SELECT * FROM selected';
        const { rows } = await pool.query(query);
        rows.forEach(row => {
            console.log(`${row.id} | ${row.game} | ${row.date} | ${row.player} | ${row.current_points} | ${row.line} | ${row.difference} | ${row.odds} | ${row.hit}`);
        });
        res.send('All rows printed to console.'); // Inform the client that the operation was successful
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
schedule.scheduleJob('00 22 * * *', function() {
    console.log(`${new Date().toISOString()} - Setting up game checks...`);
    setupGameChecks();
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
        performEndGameCheck(game);
    });
}

async function performEndGameCheck(gameId) {
    const playerStats = await fetchEndGameStats(gameId); // Ensure this fetches updated stats
    const bets = await fetchStoredBets(gameId); // This needs a new function to retrieve bets from DB

    bets.forEach(async (bet) => {
        const playerStat = playerStats.find(p => p.PlayerID === bet.player_id); // Adjust field as necessary
        if (playerStat && playerStat.Points >= bet.line) {
            updateHitStatus(bet.id, true); // Mark 'hit' as true if condition met
        }
    });
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
async function fetchStoredBets(gameId) {
    const query = 'SELECT id, player, line FROM selected WHERE game = $1';
    const { rows } = await pool.query(query, [gameId]);
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
            const hit = bet.DifferenceNeeded <= 5; // Example logic for 'hit'
            const game = `${homeTeam} vs ${awayTeam}`;
            return pool.query(query, [
                game,
                gameDate,
                bet.PlayerName,
                bet.CurrentPoints,
                bet.Line,
                bet.DifferenceNeeded,
                bet.Odds,
                false
            ]);
        }));
        console.log(`Data has been written to the database for game ${homeTeam} vs ${awayTeam}.`);
    } catch (err) {
        console.error('Error writing to database:', err);
    }
}