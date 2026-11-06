const axios = require('axios');
const fs = require('fs');

async function generateFPLPredictions() {
    console.log("Dohvaćam FPL podatke za model (bez smanjenja za flagged igrače)...");
    
    try {
        const bootstrapResponse = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
        const data = bootstrapResponse.data;
        
        const players = data.elements;
        const teams = data.teams;
        const positions = data.element_types;

        const teamMap = {};
        for (let i = 0; i < teams.length; i++) {
            let team = teams[i];
            teamMap[team.id] = { id: team.id, name: team.name, short_name: team.short_name };
        }

        const positionMap = {};
        for (let i = 0; i < positions.length; i++) {
            let pos = positions[i];
            positionMap[pos.id] = pos.singular_name_short;
        }

        console.log("Dohvaćam detaljnu historiju igrača...");
        const playerDetails = {};
        
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (player.status === 'u') continue;

            try {
                const url = `https://fantasy.premierleague.com/api/element-summary/${player.id}/`;
                const res = await axios.get(url);
                playerDetails[player.id] = {
                    history: res.data.history,
                    fixtures: res.data.fixtures
                };
            } catch (err) {
                // Preskoči greške
            }
        }

        const teamAggregates = {};
        for (let i = 0; i < teams.length; i++) {
            teamAggregates[teams[i].id] = { conceded_xg: 0, scored_xg: 0 };
        }

        for (let i = 0; i < players.length; i++) {
            let player = players[i];
            let details = playerDetails[player.id];
            if (!details || !details.history) continue;
            let tId = player.team;
            if (!teamAggregates[tId]) continue;

            for (let j = 0; j < details.history.length; j++) {
                let m = details.history[j];
                teamAggregates[tId].scored_xg += parseFloat(m.expected_goals) || 0;
                teamAggregates[tId].conceded_xg += parseFloat(m.expected_goals_conceded) || 0;
            }
        }

        let firstPlayerKey = Object.keys(playerDetails)[0];
        let sampleHistory = firstPlayerKey ? playerDetails[firstPlayerKey].history : [];
        let totalGameweeksPlayed = sampleHistory.length > 0 ? sampleHistory[sampleHistory.length - 1].round : 1;

        let totalLeagueXg = 0;
        let totalLeagueXgc = 0;
        let teamIds = Object.keys(teamAggregates);

        for (let i = 0; i < teamIds.length; i++) {
            let tId = teamIds[i];
            teamAggregates[tId].scored_xg_per_match = teamAggregates[tId].scored_xg / (totalGameweeksPlayed * 11);
            teamAggregates[tId].conceded_xg_per_match = teamAggregates[tId].conceded_xg / (totalGameweeksPlayed * 11);

            totalLeagueXg += teamAggregates[tId].scored_xg_per_match;
            totalLeagueXgc += teamAggregates[tId].conceded_xg_per_match;
        }

        let leagueAvgXgPerTeam = totalLeagueXg / teamIds.length;
        let leagueAvgXgcPerTeam = totalLeagueXgc / teamIds.length;

        console.log("Obrađujem igrače s čistim modelom (bez umanjenja)...");
        const predictionsData = [];

        for (let i = 0; i < players.length; i++) {
            let player = players[i];
            if (player.status === 'u') continue;
            let details = playerDetails[player.id];
            if (!details) continue;

            let history = details.history;
            let fixtures = details.fixtures;

            if (history.length === 0) continue;

            let season_mins = 0;
            let season_appearances = 0;
            let season_xgi = 0;
            let season_actual_gi = 0;

            for (let j = 0; j < history.length; j++) {
                let m = history[j];
                let mins = m.minutes || 0;
                season_mins += mins;
                if (mins > 0) season_appearances++;
                
                season_xgi += (parseFloat(m.expected_goals) || 0) + (parseFloat(m.expected_assists) || 0);
                season_actual_gi += (m.goals_scored || 0) + (m.assists || 0);
            }

            let avgMinutesPerAppearance = season_appearances > 0 ? (season_mins / season_appearances) : 0;
            let isRegularStarter = season_appearances > 0 && avgMinutesPerAppearance >= 45;

            let nextFixture = fixtures && fixtures.length > 0 ? fixtures[0] : null;
            let nextOpponentString = "BLANK";

            if (nextFixture) {
                let oppId = nextFixture.is_home ? nextFixture.team_a : nextFixture.team_h;
                let oppShort = teamMap[oppId] ? teamMap[oppId].short_name : 'UNK';
                let venue = nextFixture.is_home ? '(H)' : '(A)';
                nextOpponentString = `${oppShort} ${venue}`;
            }

            let nextMatchGI = 0;
            let next5GI = 0;
            let next10GI = 0;

            if (isRegularStarter) {
                let last5 = history.slice(-5);
                let l5_xgi = 0, l5_mins = 0;
                
                for (let j = 0; j < last5.length; j++) {
                    let m = last5[j];
                    l5_xgi += (parseFloat(m.expected_goals) || 0) + (parseFloat(m.expected_assists) || 0);
                    l5_mins += m.minutes || 0;
                }

                let rateL5 = l5_mins > 0 ? (l5_xgi / l5_mins) : 0;
                let rateSeason = season_mins > 0 ? (season_xgi / season_mins) : 0;

                let confidenceFactor = Math.min(l5_mins / 325, 1.0);
                let adjustedRateL5 = rateL5 * confidenceFactor;

                let baseCombinedRate = (adjustedRateL5 * 0.35) + (rateSeason * 0.65);
                let longTermCombinedRate = (adjustedRateL5 * 0.20) + (rateSeason * 0.80);

                let finishingIndex = 1.0;
                if (season_xgi > 2.0) {
                    let rawRatio = season_actual_gi / season_xgi;
                    finishingIndex = Math.min(Math.max(rawRatio, 0.70), 1.10);
                }

                let combinedRate = baseCombinedRate * finishingIndex;
                let longTermRate = longTermCombinedRate * finishingIndex;

                let l5MatchesPlayed = 0;
                for (let j = 0; j < last5.length; j++) {
                    if ((last5[j].minutes || 0) > 0) l5MatchesPlayed++;
                }
                
                let avgL5Mins = l5MatchesPlayed > 0 ? (l5_mins / l5MatchesPlayed) : 90;
                let expectedMatchMinutes = Math.min(avgL5Mins, 90);

                let playerTeamId = player.team;
                let teamAttackXg = teamAggregates[playerTeamId] ? teamAggregates[playerTeamId].scored_xg_per_match : leagueAvgXgPerTeam;
                let teamAttackCoefficient = teamAttackXg / leagueAvgXgPerTeam;

                function calculateMatchXGI(fixture) {
                    if (!fixture) return 0;
                    let isHome = fixture.is_home;
                    let oppTeamId = isHome ? fixture.team_a : fixture.team_h;
                    
                    let oppConcededXgc = teamAggregates[oppTeamId] ? teamAggregates[oppTeamId].conceded_xg_per_match : leagueAvgXgcPerTeam;
                    let oppDefCoefficient = oppConcededXgc / leagueAvgXgcPerTeam;
                    
                    let venueMultiplier = isHome ? 1.10 : 0.95;

                    return combinedRate * expectedMatchMinutes * oppDefCoefficient * teamAttackCoefficient * venueMultiplier;
                }

                function calculateLongTermMatchXGI(fixture) {
                    if (!fixture) return 0;
                    let isHome = fixture.is_home;
                    let oppTeamId = isHome ? fixture.team_a : fixture.team_h;
                    
                    let oppConcededXgc = teamAggregates[oppTeamId] ? teamAggregates[oppTeamId].conceded_xg_per_match : leagueAvgXgcPerTeam;
                    let oppDefCoefficient = oppConcededXgc / leagueAvgXgcPerTeam;
                    
                    let venueMultiplier = isHome ? 1.10 : 0.95;

                    return longTermRate * expectedMatchMinutes * oppDefCoefficient * teamAttackCoefficient * venueMultiplier;
                }

                if (nextFixture) {
                    // Čista projekcija bez ikakvog množenja sa chanceOfPlaying faktorom
                    nextMatchGI = calculateMatchXGI(nextFixture);
                }

                let next5Fixtures = fixtures.slice(0, 5);
                for (let j = 0; j < next5Fixtures.length; j++) {
                    next5GI += calculateMatchXGI(next5Fixtures[j]);
                }

                let next10Fixtures = fixtures.slice(0, 10);
                for (let j = 0; j < next10Fixtures.length; j++) {
                    next10GI += calculateLongTermMatchXGI(next10Fixtures[j]);
                }

            } else {
                nextMatchGI = 0.01;
                next5GI = 0.05;
                next10GI = 0.10;
            }

            predictionsData.push({
                name: `${player.first_name} ${player.second_name}`,
                team: teamMap[player.team] ? teamMap[player.team].name : 'Unknown',
                short_team: teamMap[player.team] ? teamMap[player.team].short_name : 'UNK',
                position: positionMap[player.element_type] || 'Unknown',
                price: (player.now_cost / 10).toFixed(1),
                next_opponent: nextOpponentString,
                projected_gi_next: Number(nextMatchGI.toFixed(2)),
                projected_gi_next5: Number(next5GI.toFixed(2)),
                projected_gi_next10: Number(next10GI.toFixed(2)),
                chance_of_playing: player.chance_of_playing_next_round ?? 100,
                status: player.status
            });
        }

        fs.writeFileSync('predictions.json', JSON.stringify(predictionsData, null, 2), 'utf-8');
        console.log("Uspješno generiran 'predictions.json' s čistim brojkama (bez umanjenja za flagove)!");

    } catch (error) {
        console.error("Greška pri generiranju predikcija:", error.message);
    }
}

generateFPLPredictions();