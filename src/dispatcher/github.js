const config = require('../nconf').get('dispatcher').github;
const GithubApi = require('github');
const path = require('path');
const render = require('./renderer');

const github = new GithubApi();

function createIssue(owner, repo, title, body, labels) {
    github.authenticate(config.authentication);

    return github.issues.create({
        owner,
        repo,
        title,
        body,
        labels,
    });
}

function dispatch(ad) {
    const rendered = render(ad, 'markdown');
    const labels = (config.labels || [])
        .concat(ad.matchingAreas || [])
        .concat(ad.extraLabels || []);

    return createIssue(config.repoOwner, config.repoName, rendered.title, rendered.body, labels).catch(err =>
        console.error(err)
    );
}

module.exports = dispatch;
