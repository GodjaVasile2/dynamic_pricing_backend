require('dotenv').config(); // Încarcă variabilele din .env
const coap = require('coap');
const cbor = require('cbor');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { DateTime } = require("luxon");
const tzlookup = require("tz-lookup"); // Mapare coordonate -> timezone

const app = express();
app.use(cors());
app.use(express.json());

// Variabile de configurare
const MONGO_URI = process.env.MONGO_URI;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const TRAFFIC_API_KEY = process.env.TRAFFIC_API_KEY;

const groupCache = {}; // Obiect global pentru caching

// === 2. Conexiunea la MongoDB ===
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB successfully."))
    .catch((err) => console.error("Error connecting to MongoDB:", err));

// === 3. Modelele Mongoose ===
const ParkingEventSchema = new mongoose.Schema({
    event_id: { type: String, required: true, unique: true },
    spot_id: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    status: { type: String, enum: ["free", "occupied"], required: true },
    timestamp: { type: Date, required: true },
});

const GroupSchema = new mongoose.Schema({
    group_id: { type: String, required: true, unique: true },
    center: {
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
    },
    spots: [{ spot_id: { type: String, required: true } }],
    last_updated: { type: Date, default: Date.now },
});

const ParkingEvent = mongoose.model('ParkingEvent', ParkingEventSchema);
const Group = mongoose.model('Group', GroupSchema);

// === 4. Funcțiile Utilitare ===

// Logarea unui eveniment de parcare
async function logParkingEvent(spotId, latitude, longitude, status, timestamp) {
    const eventId = `evt_${new Date().getTime()}_${spotId}`;
    const event = new ParkingEvent({
        event_id: eventId,
        spot_id: spotId,
        latitude,
        longitude,
        status,
        timestamp,
    });

    try {
        await event.save();
        console.log(`Event logged for spot: ${spotId}`);

        // Actualizează grupurile după adăugarea unui spot nou
        const allSpots = await ParkingEvent.aggregate([
            { $group: { _id: "$spot_id", latitude: { $first: "$latitude" }, longitude: { $first: "$longitude" } } }
        ]);
        await groupSpotsByProximity(allSpots);
    } catch (error) {
        console.error(`Error logging event for spot ${spotId}:`, error.message);
    }
}

// Gruparea locurilor de parcare după proximitate
async function groupSpotsByProximity(spots, tolerance = 0.01) {
    const groups = [];

    for (const spot of spots) {
        let added = false;

        for (const group of groups) {
            const groupCenter = group.center;
            const distance = Math.sqrt(
                Math.pow(groupCenter.latitude - spot.latitude, 2) +
                Math.pow(groupCenter.longitude - spot.longitude, 2)
            );

            if (distance <= tolerance) {
                group.spots.push({ spot_id: spot._id });
                group.center.latitude = (group.center.latitude * (group.spots.length - 1) + spot.latitude) / group.spots.length;
                group.center.longitude = (group.center.longitude * (group.spots.length - 1) + spot.longitude) / group.spots.length;
                added = true;
                break;
            }
        }

        if (!added) {
            groups.push({
                center: { latitude: spot.latitude, longitude: spot.longitude },
                spots: [{ spot_id: spot._id }],
            });
        }
    }

    for (const group of groups) {
        const groupId = `${group.center.latitude.toFixed(4)}_${group.center.longitude.toFixed(4)}`;
        await Group.updateOne(
            { group_id: groupId },
            { ...group, group_id: groupId },
            { upsert: true }
        );
    }

    return groups;
}

// Obține vremea pentru o locație
async function getWeatherForLocation(lat, lon) {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}`;

    try {
        const response = await axios.get(url);
        const weatherData = response.data;

        return {
            temperature: weatherData.main.temp,
            condition: weatherData.weather[0].main,
        };
    } catch (error) {
        console.error(`Error fetching weather for location (${lat}, ${lon}):`, error.message);
        throw new Error('Failed to fetch weather data.');
    }
}

// Obține Jam Factor pentru un grup
async function getJamFactorForGroup(latitude, longitude) {
    const radius = 200; // Rază de 200m
    const boundingBox = {
        north: latitude + (radius / 111320),
        south: latitude - (radius / 111320),
        east: longitude + (radius / (111320 * Math.cos(latitude * (Math.PI / 180)))),
        west: longitude - (radius / (111320 * Math.cos(latitude * (Math.PI / 180)))),
    };

    const url = 'https://data.traffic.hereapi.com/v7/flow';
    const params = {
        in: `bbox:${boundingBox.west},${boundingBox.south},${boundingBox.east},${boundingBox.north}`,
        apiKey: TRAFFIC_API_KEY,
        locationReferencing: 'shape',
    };

    try {
        const response = await axios.get(url, { params });
        const trafficData = response.data;
        const jamFactors = trafficData.results.map((result) => result.currentFlow.jamFactor);
        const averageJamFactor = jamFactors.reduce((sum, jf) => sum + jf, 0) / jamFactors.length;

        return averageJamFactor || 0;
    } catch (error) {
        console.error(`Error fetching traffic data for group (${latitude}, ${longitude}):`, error.message);
        return 0;
    }
}
// Funcție pentru a calcula timpul local pe baza coordonatelor
function getLocalTime(lat, lon) {
    try {
        const timezone = tzlookup(lat, lon); // Obține fusul orar
        const localTime = DateTime.now().setZone(timezone); // Convertește la ora locală
        return localTime; // Returnează obiectul Luxon DateTime
    } catch (error) {
        console.error(`Error fetching timezone for coordinates (${lat}, ${lon}):`, error.message);
        return DateTime.now(); // Fallback la timpul serverului
    }
}

// Cache Jam Factor și Weather
async function getCachedJamFactorAndWeather(groupId, latitude, longitude) {
    const currentTime = Date.now();
    const cacheExpiry = 5 * 60 * 1000;

    if (groupCache[groupId] && currentTime - groupCache[groupId].timestamp < cacheExpiry) {
        return groupCache[groupId];
    }

    const [jamFactor, weather] = await Promise.all([
        getJamFactorForGroup(latitude, longitude),
        getWeatherForLocation(latitude, longitude),
    ]);

    groupCache[groupId] = { jamFactor, weather, timestamp: currentTime };
    return groupCache[groupId];
}

async function calculateOccupancyRate(spotId) {
    const events = await ParkingEvent.find({ spot_id: spotId }).sort({ timestamp: 1 });
    let totalTime = 0;
    let occupiedTime = 0;

    for (let i = 1; i < events.length; i++) {
        const prevEvent = events[i - 1];
        const currEvent = events[i];
        const timeDiff = (new Date(currEvent.timestamp) - new Date(prevEvent.timestamp)) / 1000;

        totalTime += timeDiff;
        if (prevEvent.status === "occupied") {
            occupiedTime += timeDiff;
        }
    }

    return totalTime > 0 ? occupiedTime / totalTime : 0;
}


// Calculează prețul dinamic
function calculateDynamicPrice(basePrice, occupancyRate, timeOfDay, weatherCondition, jamFactor) {
    let price = basePrice;
    if (occupancyRate > 0.7) price += basePrice * 0.2;
    if ((timeOfDay >= 8 && timeOfDay <= 10) || (timeOfDay >= 17 && timeOfDay <= 19)) {
        price += basePrice * 0.15;
    }
    if (weatherCondition === 'rainy' || weatherCondition === 'snowy') {
        price += basePrice * 0.1;
    }
    if (jamFactor >= 2 && jamFactor < 4) {
        price += basePrice * 0.1;
    } else if (jamFactor >= 4) {
        price += basePrice * 0.2;
    }
    return price.toFixed(2);
}


// === 5. Endpoint-uri Express ===
app.get('/api/parking-prices', async (req, res) => {
    try {
        const basePrice = 10;
        const groups = await Group.find();
        const spotsWithPrices = [];

        for (const group of groups) {
            const { jamFactor, weather } = await getCachedJamFactorAndWeather(
                group.group_id,
                group.center.latitude,
                group.center.longitude
            );

            const localTime = getLocalTime(group.center.latitude, group.center.longitude);
            const localHour = localTime.hour; // Ora locală
        

            for (const spot of group.spots) {
                const occupancyRate = await calculateOccupancyRate(spot.spot_id);
                const price = calculateDynamicPrice(basePrice, occupancyRate, localHour, weather.condition, jamFactor);
                
                const spotData = await ParkingEvent.findOne({ spot_id: spot.spot_id }).select("latitude longitude status").lean();

                spotsWithPrices.push({
                    spot_id: spot.spot_id,
                    latitude: spotData.latitude, // Coordonatele spotului
                    longitude: spotData.longitude, // Coordonatele spotului
                    status: spotData.status,
                    price,
                    weather,
                    jam_factor: jamFactor.toFixed(2),
                    occupancy_rate: (occupancyRate * 100).toFixed(2),
                    local_time: localTime.toISO(), // Adaugă timpul local în răspuns
                });
            }
        }

        res.json(spotsWithPrices);
    } catch (err) {
        console.error('Error calculating prices:', err.message);
        res.status(500).send('Error calculating prices.');
    }
});

// === 6. Server CoAP ===
const coapServer = coap.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/parking-status') {
        let body = [];
        req.on('data', (chunk) => body.push(chunk));

        req.on('end', async () => {
            try {
                const payload = cbor.decode(Buffer.concat(body)); // Decodifică payload-ul CBOR
                const parkingStatus = payload.parking_status;

                const logOperations = parkingStatus.map(async (spot) => 
                    logParkingEvent(spot.id, spot.lat, spot.lon, spot.s === 1 ? 'free' : 'occupied', new Date(payload.timestamp))
                );

                await Promise.all(logOperations); // Asigură salvarea tuturor evenimentelor de parcare
                res.end('Data saved successfully.');
            } catch (err) {
                console.error('Error decoding or saving data:', err.message);
                res.statusCode = 400;
                res.end('Error decoding or saving data.');
            }
        });
    } else {
        res.statusCode = 404;
        res.end('Resource not found.');
    }
});

// === 7. Serverele Express și CoAP ===
coapServer.listen(3002, () => console.log('CoAP server running on port 3002'));
app.listen(3001, () => console.log('HTTP server running on port 3001'));