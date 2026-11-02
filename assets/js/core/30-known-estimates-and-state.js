"use strict";

/* Public map-tile configuration is centralized here so providers can be
       changed without editing rendering or export code. Web map requests must
       preserve a normal HTTPS referrer and browser caching behavior. */
    const MAP_TILE_CONFIG = Object.freeze({
      referrerPolicy: "strict-origin-when-cross-origin",
      probeTimeoutMs: 7000,
      providers: Object.freeze({
        street: Object.freeze({
          key: "street",
          label: "Street map",
          url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          probeUrl: "https://tile.openstreetmap.org/0/0/0.png",
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
          printAttribution: "© OpenStreetMap contributors"
        }),
        topographic: Object.freeze({
          key: "topographic",
          label: "Topographic backup",
          url: "https://tile.openmaps.fr/opentopomap/{z}/{x}/{y}.png",
          probeUrl: "https://tile.openmaps.fr/opentopomap/0/0/0.png",
          maxZoom: 17,
          attribution: '<a href="https://github.com/sletuffe/OpenTopoMap" target="_blank" rel="noopener noreferrer">&copy; OpenTopoMap-R</a> <a href="https://openmaps.fr/donate" target="_blank" rel="noopener noreferrer">Donation</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">&copy; OpenStreetMap</a>',
          printAttribution: "© OpenTopoMap-R · © OpenStreetMap contributors"
        })
      })
    });

/* Known planning estimates for selected common legs. Other legs use a
       geographic-distance estimate adjusted to approximate road travel. */
    const KNOWN_LEGS = {
      "sacramento|lake-tahoe": { miles: 105, hours: 2.1 },
      "sacramento|lassen": { miles: 190, hours: 3.6 },
      "lassen|burney-falls": { miles: 68, hours: 1.4 },
      "burney-falls|lava-beds": { miles: 96, hours: 1.9 },
      "lava-beds|crater-lake": { miles: 115, hours: 2.4 },
      "crater-lake|oregon-caves": { miles: 145, hours: 3.1 },
      "oregon-caves|redwood": { miles: 105, hours: 2.4 },
      "redwood|humboldt-redwoods": { miles: 98, hours: 2.0 },
      "humboldt-redwoods|mendocino": { miles: 145, hours: 3.1 },
      "mendocino|fort-ross": { miles: 96, hours: 2.3 },
      "fort-ross|point-reyes": { miles: 49, hours: 1.2 },
      "point-reyes|sonoma-history": { miles: 46, hours: 1.1 },
      "sonoma-history|sacramento": { miles: 74, hours: 1.4 },
      "sacramento|marshall-gold": { miles: 47, hours: 1.0 },
      "marshall-gold|lake-tahoe": { miles: 73, hours: 1.6 },
      "lake-tahoe|virginia-city": { miles: 48, hours: 1.1 },
      "virginia-city|bodie": { miles: 125, hours: 2.6 },
      "bodie|mono-lake": { miles: 33, hours: 0.8 },
      "mono-lake|yosemite": { miles: 75, hours: 1.8 },
      "yosemite|columbia": { miles: 76, hours: 1.8 },
      "columbia|calaveras": { miles: 31, hours: 0.7 },
      "calaveras|sacramento": { miles: 98, hours: 2.0 },
      "sacramento|pinnacles": { miles: 160, hours: 2.8 },
      "pinnacles|monterey": { miles: 55, hours: 1.2 },
      "monterey|big-sur": { miles: 30, hours: 0.8 },
      "big-sur|hearst-castle": { miles: 65, hours: 1.6 },
      "hearst-castle|san-luis-mission": { miles: 45, hours: 0.9 },
      "san-luis-mission|sacramento": { miles: 285, hours: 4.6 },
      "mono-lake|manzanar": { miles: 110, hours: 2.1 },
      "manzanar|death-valley": { miles: 145, hours: 2.7 },
      "manzanar|sequoia": { miles: 245, hours: 5.0 }
    };

    const state = {
      map: null,
      start: { id: "sacramento", name: "Sacramento, California", lat: 38.5816, lng: -121.4944, category: "Start" },
      end: { id: "sacramento", name: "Sacramento, California", lat: 38.5816, lng: -121.4944, category: "Finish" },
      routeStops: [],
      customStops: [],
      routeCreated: false,
      routePolyline: null,
      candidateLayer: null,
      routeLayer: null,
      markerIndex: new Map(),
      pendingGeocodeResults: [],
      geocodeCache: new Map(),
      lastGeocodeAt: 0,
      nominatimQueue: Promise.resolve(),
      tileErrorCount: 0,
      mapTileProvider: "uninitialized",
      mapTileHealth: "unknown",
      mapTileLastStatus: null,
      lastBuildMode: "ideas",
      lastRandomEmphasis: null,
      roadRouteCache: new Map(),
      roadRouteController: null,
      roadRouteTimer: null,
      pendingRoadRouteKey: null,
      lastRoadRequestAt: 0,
      overnightLodgingCache: new Map(),
      overnightLookupPending: new Set(),
      resolvingMustSees: false,
      sectionLayoutFocused: false,
      routeSearchLayer: null,
      plannedDriveStopLayer: null,
      plannedDriveStops: [],
      plannedDriveStopMarkerIndex: new Map(),
      routeSearchResults: [],
      routeSearchMarkerIndex: new Map(),
      routeSearchCache: new Map(),
      routeSearchController: null,
      routeSearchRouteKey: "",
      routeSearchStale: false,
      routeSearchLegSignature: ""
    };

    const $ = (id) => document.getElementById(id);
