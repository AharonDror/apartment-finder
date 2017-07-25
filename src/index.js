const os = require('os');
const geolib = require('geolib');
const moment = require('moment');
const _ = require('lodash');
const co = require('co');

const fetcher = require('./fetcher');
const dispatcher = require('./dispatcher');
const { EnhancedAd, parseAds } = require('./ad-parser');
const adsRepository = require('./ads-repository');
const management = require('./management');
const Stats = require('./stats');

const query = require('../config/query');

const log = message => console.log('[' + moment().format('HH:mm') + '] ' + message);

function addMatchingAreas(ad) {
    const matchingAreas = _.chain(query.areas)
        .defaultTo([])
        .filter(area => geolib.isPointInside(ad.coordinates, area.points))
        .flatMap(area => area.labels || [])
        .value();

    ad.setMatchingAreas(matchingAreas);
}

function addExtraLabels(ad, labels = []) {
    const traitsLabels = _.chain(query.traitsToLabel)
        .defaultTo({})
        .keys()
        .filter(trait => ad.traits[trait])
        .map(trait=> query.traitsToLabel[trait])
        .value();
    const merchantLabel = ad.merchant ? 'תיווך' : [];

    ad.setExtraLabels(_.concat(labels,traitsLabels, merchantLabel));
}

const processAds = function* (apartment) {
    const summary = new Stats();
    log(`Start process ads of ${apartment.name}`)
    const processPage = function* (pageNumber) {
        const page = yield fetcher.fetchPage(apartment.apartmentQuery, { page: currentPage });
        const ads = parseAds(page);

        summary.increment('retrieved', ads.length);

        const enhancedAds = yield _.chain(ads)
            .filter(ad => !adsRepository.wasAlreadySent(ad.id))
            .forEach(ad => summary.increment('not_already_handled'))
            .filter(ad => ad.coordinates.latitude && ad.coordinates.longitude)
            .forEach(ad => summary.increment('has_coordinates'))
            .forEach(ad => addMatchingAreas(ad))
            .filter(ad => ad.matchingAreas.length > 0)
            .forEach(ad => summary.increment('within_polygon'))
            .filter(ad => ad.publishDate.isAfter(query.minimumPublishDate))
            .forEach(ad => summary.increment('after_min_publish_date'))
            .map(ad => fetcher.fetchAd(ad).then(extraAdData => new EnhancedAd(ad, extraAdData)))
            .value();

        yield _.chain(enhancedAds)
            // .filter(ad => ad.isEntranceKnown) // If you want instant entrance you need to comment this and the next two lines
            // .forEach(ad => summary.increment('has_known_entrance_date'))
            // .filter(ad => ad.entrance >= query.minimumEntranceDate)
            // .forEach(ad => summary.increment('after_minimal_entrance_date'))
            .forEach(ad => addExtraLabels(ad, apartment.labels))
            .map(ad =>
                dispatcher(ad).then(() => {
                    adsRepository.updateSent(ad.id);
                    summary.increment('dispatched');
                })
            )
            .value();

        yield adsRepository.flush();
        management.updateStats(summary.toHtml());

        return {
            done: page.data.current_page === page.data.total_pages,
        };
    };

    let currentPage = 1;
    while (true) {
        try {
            const result = yield processPage(currentPage++);

            if (result.done) {
                break;
            }
        } catch (error) {
            log(error);
        }
    }

    log(`Done process of ${apartment.name}!`);
    log(summary.toString() + os.EOL + os.EOL);
};

const processAdsForEachSearchQuery = co.wrap(function* () {
    for (let i = 0; i < query.apartments.length; i++) {
        yield processAds(query.apartments[i])
    }
    log('Done with run!');
})

processAdsForEachSearchQuery();
setInterval(processAdsForEachSearchQuery, 60 * 60 * 1000);
