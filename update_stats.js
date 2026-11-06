const axios = require('axios');
const fs = require('fs');

async function generateFPLStats() {
    console.log("Dohvaćam osnovne podatke o igračima i klubovima...");
    
    try {
        // 1. Povuci glavni bootstrap-static endpoint da dobijemo listu svih igrača i klubova
        const bootstrapResponse = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
        const data = bootstrapResponse.data;
        
        const players = data.elements;
        const teams = data.teams;
        const positions = data.element_types;

        // Mapiramo ID kluba u ime kluba (npr. 1 -> Manchester City)
        const teamMap = {};
        teams.forEach(team => {
            teamMap[team.id] = { name: team.name, short_name: team.short_name };
        });

        // Mapiramo poziciju (1 -> GKP, 2 -> DEF, 3 -> MID, 4 -> FWD)
        const positionMap = {};
        positions.forEach(pos => {
            positionMap[pos.id] = pos.singular_name_short;
        });

        console.log(`Pronađeno ${players.length} igrača. Krećem s dohvaćanjem detaljne statistike po igračima (ovo može potrajati minutu-dvije)...`);

        const summaryData = [];

        // 2. Prolazimo kroz svakog igrača i skidamo njegov endpoint za historiju
        // (ide redom kroz sve ID-jeve)
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            
            // Preskoči igrače koji uopće nisu igrali ili su ubačeni s 0 minuta/nepoznati
            if (player.status === 'u') continue; 

            try {
                const url = `https://fantasy.premierleague.com/api/element-summary/${player.id}/`;
                const res = await axios.get(url);
                const history = res.data.history;

                // Uzmi zadnjih 5 odigranih kola (ako ih ima manje od 5, uzmi koliko ih ima)
                const last5 = history.slice(-5);

                let l5_minutes = 0;
                let l5_goals = 0;
                let l5_assists = 0;
                let l5_points = 0;
                let l5_xg = 0;
                let l5_xa = 0;
                let l5_def_contrib = 0;
                let l5_shots_threat = 0; // Možemo koristiti 'threat' ili zbrojiti izračunate metrike

                last5.forEach(match => {
                    l5_minutes += match.minutes || 0;
                    l5_goals += match.goals_scored || 0;
                    l5_assists += match.assists || 0;
                    l5_points += match.total_points || 0;
                    l5_xg += parseFloat(match.expected_goals) || 0;
                    l5_xa += parseFloat(match.expected_assists) || 0;
                    l5_def_contrib += match.defensive_contribution || 0;
                    l5_shots_threat += parseFloat(match.threat) || 0;
                });

                // Posloži objekt za tog igrača
                summaryData.push({
                    id: player.id,
                    name: `${player.first_name} ${player.second_name}`,
                    team: teamMap[player.team] ? teamMap[player.team].name : 'Unknown',
                    position: positionMap[player.element_type] || 'Unknown',
                    price: (player.now_cost / 10).toFixed(1), // FPL cijene su npr. 150 što znači 15.0 miliona
                    total_points: player.total_points,
                    form: player.form,
                    // Statistika zadnjih 5 kola:
                    l5_matches_played: last5.length,
                    l5_minutes: l5_minutes,
                    l5_points: l5_points,
                    l5_goals: l5_goals,
                    l5_assists: l5_assists,
                    l5_xg: Number(l5_xg.toFixed(2)),
                    l5_xa: Number(l5_xa.toFixed(2)),
                    l5_xgi: Number((l5_xg + l5_xa).toFixed(2)), // Expected Goal Involvements
                    l5_def_contrib: l5_def_contrib,
                    l5_threat: Number(l5_shots_threat.toFixed(1))
                });

                // Mali pauza da ne preopteretimo FPL server prebrzim zahtjevima (opcionalno ali preporučljivo)
                // await new Promise(resolve => setTimeout(resolve, 50));

            } catch (err) {
                // Ako neki igrač izbaci grešku (npr. obrisan je ili nema podatke), preskoči ga
                console.log(`Preskačem igrača ID ${player.id} zbog greške.`);
            }

            // Ispis napretka u terminalu
            if ((i + 1) % 50 === 0 || i === players.length - 1) {
                console.log(`Obrađeno ${i + 1} / ${players.length} igrača...`);
            }
        }

        // 3. Spremi sve u JSON fajl
        fs.writeFileSync('fpl_summary.json', JSON.stringify(summaryData, null, 2), 'utf-8');
        console.log("Uspješno generiran fajl 'fpl_summary.json'! Spreman za HTML stranicu.");

    }

    catch (error) {
        console.error("Greška pri dohvaćanju FPL podataka:", error.message);
    }
}

generateFPLStats();