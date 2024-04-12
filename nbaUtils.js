import axios from 'axios';
import { format, addDays } from 'date-fns';
import moment from 'moment-timezone';
import fetch from 'node-fetch'; // Ensure you're using ESM-compatible versions if directly importing


// API keys - Ideally, these should be stored in environment variables for security reasons
const apiKeyOdds = '462be662d64996c551b7bb73440aa51f'; // Your Odds API key
const apiKeyRapid = '472352de43msh205a31c3062c280p10181djsn3cfbf0fca7ea'; // Your RapidAPI key
let gamesToday = [];
let playerStatsInfo = [];
let allGameData = [];
//GETGAMES
export async function getCombinedNBAGames() {
    const currentDate = new Date();
    const currentDateEST = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    const dateString = format(currentDate, "yyyy-MM-dd"); // Format current date to YYYY-MM-DD
    const nextDayDate = format(addDays(currentDate, 1), "yyyy-MM-dd"); // Get next day's date

    const commenceTimeFrom = `${dateString}T00:00:00Z`;
    const commenceTimeTo = `${nextDayDate}T10:00:00Z`; // Include games until 3 AM EST next day (which is 7 AM UTC)

    const oddsApiUrl = `https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${apiKeyOdds}&commenceTimeFrom=${commenceTimeFrom}&commenceTimeTo=${commenceTimeTo}&dateFormat=iso`;
    const formattedDate = new Date(currentDateEST).toISOString().split('T')[0];
    const rapidApiUrl = `https://api-nba-v1.p.rapidapi.com/games?date=${formattedDate}`;
    const rapidApiOptions = {
        method: 'GET',
        headers: {
            'X-RapidAPI-Key': apiKeyRapid,
            'X-RapidAPI-Host': 'api-nba-v1.p.rapidapi.com'
        }
    };

    try {
        const [oddsResponse, rapidResponse] = await Promise.all([
            axios.get(oddsApiUrl),
            fetch(rapidApiUrl, rapidApiOptions).then(res => res.json())
        ]);

        const oddsGames = oddsResponse.data;
        const rapidGames = rapidResponse.response;

        const combinedGames = oddsGames.reduce((acc, oddsGame) => {
            const rapidGame = rapidGames.find(rg => rg.homeTeam.name === oddsGame.home_team && rg.awayTeam.name === oddsGame.away_team);
            if (rapidGame && rapidGame.id) { // Ensure rapidGame exists and has a gameId
                acc.push({
                    ...oddsGame,
                    gameId: rapidGame.id,
                    homeTeam: {
                      name: rapidGame.teams.home.name,
                      alias: rapidGame.teams.home.code,
                    },
                    awayTeam: {
                      name: rapidGame.teams.visitors.name,
                      alias: rapidGame.teams.visitors.code,
                    },
                    date: moment(rapidGame.date.start).tz('America/New_York').format('YYYY-MM-DD'),
                    time: moment(rapidGame.date.start).tz('America/New_York').format('HH:mm')
                });
            }
            return acc;
        }, []);

        console.log("Combined Games:", combinedGames);
        return combinedGames;
    } catch (error) {
        console.error('Error fetching combined NBA games:', error);
        return [];
    }
}


//CHECK HALFTIME
export async function checkHalftimeStatus(gameId) {
    const url = `https://api-nba-v1.p.rapidapi.com/games?id=${gameId}`;
    const options = {
        method: 'GET',
        headers: {
            'X-RapidAPI-Key': apiKeyRapid,
            'X-RapidAPI-Host': 'api-nba-v1.p.rapidapi.com'
        }
    };

    try {
        const response = await fetch(url, options);
        const data = await response.json();
        const isHalftime = data.response[0].status.halftime;
        console.log(`Halftime status for game ${gameId}:`, isHalftime);

       
        return isHalftime;
    } catch (error) {
        console.error(`Error checking halftime status for game ${gameId}:`, error);
        return false; // Default to false if there's an error
    }
}



  export async function getNBAGamePlayerProps(DKGameID) {
    try {
        // Construct the URL to fetch player props for a specific game using DKGameID
        const oddsUrl = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${DKGameID}/odds?apiKey=${apiKeyOdds}&regions=us&markets=player_points&oddsFormat=american`;

        const oddsResponse = await axios.get(oddsUrl);
        const draftKings = oddsResponse.data.bookmakers.find(bkmk => bkmk.key === 'draftkings');

        if (!draftKings) {
            console.log(`No player props available for game ID ${DKGameID} from DraftKings.`);
            return null;
        }

        const gameProps = {
            DKGameID: DKGameID,
            bets: []
        };

        // Extract player props bets from the DraftKings market data
        draftKings.markets.forEach(market => {
            market.outcomes.forEach(outcome => {
                if (outcome.name === 'Over') {  // Filter to include only 'Over' bets
                    const betDetails = {
                        player: outcome.description,
                        bet: outcome.name,
                        price: outcome.price,
                        point: outcome.point
                    };
                    gameProps.bets.push(betDetails);
                }
            });
        });

        console.log(`Player props for game ID ${DKGameID}:`, gameProps);
        return gameProps;
    } catch (error) {
        console.error(`Error fetching player props for NBA game ID ${DKGameID}:`, error);
        return null;
    }
}

export async function fetchPlayerStatsForGame(gameId) {
    const options = {
        method: 'GET',
        url: 'https://api-nba-v1.p.rapidapi.com/players/statistics',
        params: {game: gameId},
        headers: {
            'X-RapidAPI-Key': '472352de43msh205a31c3062c280p10181djsn3cfbf0fca7ea',
            'X-RapidAPI-Host': 'api-nba-v1.p.rapidapi.com'
        }
    };

    try {
        const response = await axios.request(options);
        const stats = response.data.response;

        // Storing each player's stats in the global array
        stats.forEach(stat => {
            playerStatsInfo.push({
                PlayerID: stat.player.id,
                PlayerName: `${stat.player.firstname} ${stat.player.lastname}`,
                Team: stat.team.name,
                Game: {
                    GameID: stat.game.id,
                    Date: stat.game.date,
                    Status: stat.game.status
                },
                Points: stat.points,
                Position: stat.pos,
                Minutes: stat.min,
                FieldGoalsMade: stat.fgm,
                FieldGoalsAttempted: stat.fga,
                FieldGoalPercentage: stat.fgp,
                FreeThrowsMade: stat.ftm,
                FreeThrowsAttempted: stat.fta,
                FreeThrowPercentage: stat.ftp,
                ThreePointMade: stat.tpm,
                ThreePointAttempted: stat.tpa,
                ThreePointPercentage: stat.tpp,
                OffensiveRebounds: stat.offReb,
                DefensiveRebounds: stat.defReb,
                TotalRebounds: stat.totReb,
                Assists: stat.assists,
                PersonalFouls: stat.pFouls,
                Steals: stat.steals,
                Turnovers: stat.turnovers,
                Blocks: stat.blocks,
                PlusMinus: stat.plusMinus,
                Comment: stat.comment
            });
        });
    } catch (error) {
        console.error(`Error fetching player stats for game ${gameId}:`, error);
    }

    return playerStatsInfo; // Return the updated array for use elsewhere
}


export async function aggregateGameData(gameId) {
    try {
        // Find game by gameId in your stored gamesToday or refetch necessary game data
        const game = gamesToday.find(g => g.gameId === gameId);
        if (!game) {
            console.error(`Game with ID ${gameId} not found.`);
            return;
        }

        // Fetch player props and player stats
        const playerProps = await getNBAGamePlayerProps(game.DKGameID);
        const playerStats = await fetchPlayerStatsForGame(gameId);

       // Combine all relevant game data
       const completeGameData = {
        ...game,
        playerProps,
        playerStats
    };

    // Push the aggregated data into the global array
    allGameData.push(completeGameData);

        console.log(`Aggregated game data for game ID ${gameId}:`, completeGameData);
        return completeGameData;
    } catch (error) {
        console.error(`Error aggregating data for game ${gameId}:`, error);
    }
}



export async function predict(gameId) {
    // Retrieve the aggregated game data from the global array by gameId
    const game = allGameData.find(g => g.gameId === gameId);

    // Ensure that the game data and player stats are found
    if (!game || !game.playerStats || game.playerStats.length === 0) {
        console.log("Game or player stats not found.");
        return [];
    }

    // Result array to store selected bets
    const selectedBets = [];

    // Loop through each bet in the playerProps part of the game data
    if (game.playerProps && game.playerProps.bets) {
        game.playerProps.bets.forEach(bet => {
            const playerStat = game.playerStats.find(ps => `${ps.PlayerName}` === bet.player);
            if (playerStat) {
                const actualPoints = playerStat.Points;
                const roundedLine = Math.ceil(bet.point);  // Round up the line
                const difference = roundedLine - actualPoints;
                
                // Check if the difference is within half of the current points
                if (difference <= actualPoints / 2) {
                    const fieldGoalAttemptsHalf = Math.ceil(playerStat.FieldGoalsAttempted / 2);
                    const potentialPointsFromAttempts = fieldGoalAttemptsHalf * 2;

                    // Check if half the field goal attempts cover the difference
                    if (potentialPointsFromAttempts >= difference) {
                        selectedBets.push({
                            PlayerName: bet.player,
                            CurrentPoints: actualPoints,
                            Line: roundedLine,
                            Odds: bet.price,
                            DifferenceNeeded: difference
                        });
                    }
                }
            }
        });
    }

    console.log(`Selected bets for game ${gameId}:`, selectedBets);
    return selectedBets;
}