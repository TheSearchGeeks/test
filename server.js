import express from 'express';
import schedule from 'node-schedule';
import { getCombinedNBAGames, checkHalftimeStatus, aggregateGameData, predict } from './nbaUtils.js';
import { createObjectCsvWriter } from 'csv-writer';
const app = express();
const port = process.env.PORT || 3001;

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
schedule.scheduleJob('0 23 * * *', function() {
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
        });
    } catch (error) {
        console.error("Error setting up game checks:", error);
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
        aggregateGameData(game.gameId).then(() => {
            predictAndWriteToCSV(game.gameId);
        });
        
    }
}


async function predictAndWriteToCSV(gameId) {
    const selectedBets = await predict(gameId);
    writeToCSV(selectedBets, gameId);
}

function writeToCSV(selectedBets, gameId) {
    if (selectedBets.length === 0) {
        console.log(`No bets to write for game ID ${gameId}.`);
        return;
    }
    const csvWriter = createObjectCsvWriter({
        path: `./bets_${gameId}.csv`,
        header: [
            {id: 'PlayerName', title: 'PlayerName'},
            {id: 'CurrentPoints', title: 'CurrentPoints'},
            {id: 'Line', title: 'Line'},
            {id: 'Odds', title: 'Odds'},
            {id: 'DifferenceNeeded', title: 'DifferenceNeeded'}
        ]
    });

    csvWriter.writeRecords(selectedBets)
        .then(() => console.log(`Data has been written to CSV for game ID ${gameId}.`))
        .catch(err => console.error('Error writing to CSV:', err));
}