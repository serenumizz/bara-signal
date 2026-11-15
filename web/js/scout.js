// Trend scout: which Earth-science variables could show a trend for a kind of place?
// Tools and links come from the challenge's Resources tab; the variables are real NASA / NOAA products.

export const SOURCES = {
  giovanni: { name: "Giovanni", url: "https://giovanni.gsfc.nasa.gov/" },
  hydro: { name: "Hydrology Time Series", url: "https://disc.gsfc.nasa.gov/information/tools?title=Hydrology%20Time%20Series" },
  appeears: { name: "AppEEARS", url: "https://appeears.earthdatacloud.nasa.gov/" },
  firms: { name: "NASA FIRMS", url: "https://firms.modaps.eosdis.nasa.gov/" },
  cdo: { name: "NOAA Climate Data Online", url: "https://www.ncei.noaa.gov/cdo-web/" },
  knmi: { name: "KNMI Climate Explorer", url: "https://climexp.knmi.nl/" },
  swot: { name: "SWOT mission (CSA / NASA / CNES)", url: "https://www.asc-csa.gc.ca/eng/satellites/swot/" },
  rcm: { name: "RADARSAT Constellation data (CSA)", url: "https://donnees-data.asc-csa.gc.ca/en/dataset/rcm" },
};

export const GUIDES = [
  { name: "Statistical test methods to detect trends in time series data", url: "https://medium.com/@snp.kriss/statistical-test-methods-to-detect-trends-in-time-series-data-b361a0ec530b" },
  { name: "A Comprehensive Guide to Statistical Significance", url: "https://www.statsig.com/perspectives/a-comprehensive-guide-to-statistical-significance" },
  { name: "Time-series analysis of SeaWiFS chlorophyll in river-influenced coastal regions (NASA paper)", url: "https://ntrs.nasa.gov/api/citations/20090042747/downloads/20090042747.pdf" },
];

// id -> what it is, the NASA/NOAA product, where to get the time series, and a plain definition
export const VARS = {
  precip: { name: "Rainfall", product: "GPM IMERG monthly precipitation (or MERRA-2)", src: ["giovanni", "hydro"], def: "How much rain falls, in mm per day or month." },
  t2m: { name: "Air temperature", product: "MERRA-2 2-m air temperature", src: ["giovanni"], def: "Temperature of the air near the ground." },
  station: { name: "Weather-station temperature and rainfall", product: "NOAA GHCN station records", src: ["cdo"], def: "Long, direct measurements from weather stations, often decades deep." },
  soil: { name: "Soil moisture", product: "GLDAS root-zone / surface soil moisture", src: ["giovanni", "hydro"], def: "How wet the ground is, from 0 (dry) to 1 (saturated)." },
  ndvi: { name: "Vegetation greenness (NDVI / EVI)", product: "MODIS Terra monthly vegetation indices (MOD13C2)", src: ["giovanni", "appeears"], def: "How green and dense the plants are, seen from space." },
  lst: { name: "Land-surface temperature", product: "MODIS land surface temperature (MOD11)", src: ["appeears"], def: "How hot the ground itself is, not the air above it." },
  et: { name: "Evapotranspiration", product: "MODIS evapotranspiration (MOD16)", src: ["appeears"], def: "Water returned to the air by soil and plants." },
  aod: { name: "Aerosol optical depth (haze)", product: "MODIS / MERRA-2 aerosol optical depth", src: ["giovanni"], def: "How hazy the sky is. Above about 1 it is visibly brown." },
  dust: { name: "Dust in the air", product: "MODIS Deep Blue AOD / MERRA-2 dust", src: ["giovanni"], def: "Mineral dust lifted from dry ground." },
  no2: { name: "Nitrogen dioxide", product: "OMI tropospheric NO2 column", src: ["giovanni"], def: "A traffic and industry pollutant seen from orbit." },
  co: { name: "Carbon monoxide", product: "AIRS carbon monoxide (or MOPITT)", src: ["giovanni"], def: "A gas from burning and combustion." },
  chl: { name: "Chlorophyll-a (algae)", product: "MODIS-Aqua ocean chlorophyll", src: ["giovanni"], def: "How much algae is in the water, a sign of nutrients and runoff." },
  sst: { name: "Sea-surface temperature", product: "MODIS-Aqua sea-surface temperature", src: ["giovanni"], def: "How warm the top of the sea is." },
  swh: { name: "Water-surface height", product: "SWOT rivers, lakes and coast", src: ["swot"], def: "How high the water surface sits, tracking floods, tides and drought." },
  runoff: { name: "River runoff", product: "GLDAS runoff / streamflow tools", src: ["hydro", "giovanni"], def: "Fresh water flowing off the land into rivers and the sea." },
  sar: { name: "Radar change detection", product: "RADARSAT Constellation (SAR) imagery", src: ["rcm"], def: "Radar sees through cloud and night; it maps wetlands, coasts and forest change." },
  treecover: { name: "Tree cover and forest loss", product: "MODIS Vegetation Continuous Fields (MOD44B)", src: ["appeears"], def: "Share of the land under trees, and how much has been lost." },
  fire: { name: "Active fires", product: "NASA FIRMS MODIS C6.1 fire detections (Terra + Aqua); 8-day MOD14A2 also via AppEEARS", src: ["firms", "appeears"], def: "Fire pixels the satellites spotted." },
  enso: { name: "Ocean climate indices (ENSO, IOD)", product: "NOAA ONI (Niño 3.4) and Dipole Mode Index", src: ["knmi"], def: "Slow ocean swings that change rain across the tropics." },
};

// kinds of place: variables to check (in order) and why each could trend there
export const ARCH = {
  desert: {
    label: "Desert", emoji: "🏜️", re: /desert|dunes?|sahara|gobi|arid|sahel|kalahari|atacama|gurun|sand\b|semi-?arid/i,
    vars: [
      ["precip", "A desert lives on a few rain events, so a small shift in rainfall is a big change."],
      ["ndvi", "Greening or browning at the desert edge shows whether the desert is spreading or retreating."],
      ["dust", "Dust storms rise when soil dries and wind picks up."],
      ["lst", "Bare ground heats fast, so land temperature is a sensitive thermometer."],
      ["station", "Station records can be decades long, which makes a trend easier to test."],
      ["soil", "Even small changes in ground moisture matter for plants and dust."],
    ],
  },
  rainforest: {
    label: "Rain forest", emoji: "🌴", re: /rain ?forest|amazon|jungle|tropical forest|congo|deforest|logging|hutan|tutupan/i,
    vars: [
      ["treecover", "The direct measure of forest lost or regrown."],
      ["precip", "Dry seasons that get longer or drier stress the forest."],
      ["ndvi", "Greenness drops when forest is cleared or stressed by drought."],
      ["fire", "Fire is how a stressed forest is often lost for good."],
      ["et", "Forests recycle rain; falling evapotranspiration can mean drier air."],
      ["enso", "El Niño years bring drought to many tropical forests."],
    ],
    site: { what: "forest", where: "Borneo", year: "2015", text: "Try the same idea on Borneo's forests" },
  },
  estuary: {
    label: "Tidal estuary / coast", emoji: "🌊", re: /estuar|delta|mangrove|tidal|tides?\b|coast|river mouth|lagoon|\bbay\b|muara|pesisir|pasang|wetland/i,
    vars: [
      ["chl", "Algae respond fast to river nutrients; this is the variable of the NASA paper in the resource list."],
      ["sst", "Warmer water changes algae, fish and storms."],
      ["swh", "SWOT measures water height in rivers and coasts, showing floods and tides."],
      ["runoff", "River flow carries sediment and nutrients to the coast."],
      ["sar", "Radar maps shoreline and wetland change even under cloud."],
      ["precip", "Rain over the catchment drives the river flow."],
    ],
  },
  city: {
    label: "Atmosphere above a big city", emoji: "🏙️", re: /\bcity\b|cities|urban|megacity|smog|air quality|traffic|jakarta|beijing|delhi|los angeles|mexico city|lagos|kota|polusi|udara|heat island/i,
    vars: [
      ["no2", "Traffic and industry; city-wide NO2 shows up clearly from orbit."],
      ["aod", "Fine particles make haze and harm health."],
      ["co", "Combustion from vehicles, stoves and fires."],
      ["lst", "Cities run hotter than their surroundings (the urban heat island)."],
      ["station", "Station air temperature gives a long ground-truth record."],
      ["t2m", "Warming air changes how pollution builds up."],
    ],
  },
  peat: {
    label: "Peat swamp (this site)", emoji: "🔥", re: /peat|gambut|haze|karhutla|riau|kalimantan|sumatra|sumatera|indonesia|borneo/i,
    vars: [
      ["fire", "Peat burns for weeks once it is dry."],
      ["soil", "Dry peat is the tipping point for fire."],
      ["precip", "Less rain in the dry season dries the peat."],
      ["aod", "Fire becomes haze that crosses borders."],
      ["treecover", "Cleared and drained land burns more easily."],
      ["enso", "El Niño and a positive Indian Ocean Dipole bring the worst fire years."],
    ],
    site: { what: "fire", where: "Borneo", year: "2015", text: "Open this case on the map" },
  },
};

/** Which kinds of place does this text (a place, news headline or paper title) point to? Best first. */
export function matchText(text) {
  const hits = Object.entries(ARCH).map(([id, a]) => [id, (text.match(new RegExp(a.re.source, "gi")) || []).length]).filter(([, n]) => n > 0);
  hits.sort((a, b) => b[1] - a[1]);
  return hits.map(([id]) => id);
}
