const CONTRACTOR_EMAIL_SUFFIX = '@contractor.example.invalid';
const PERMISSIONS_JIRA_URL = 'https://portico.atlassian.net/secure/CreateIssueDetails!init.jspa?pid=11182&issuetype=11076';

function isContractorEmail(email) {
  return typeof email === 'string' && email.toLowerCase().trim().endsWith(CONTRACTOR_EMAIL_SUFFIX);
}

module.exports = { CONTRACTOR_EMAIL_SUFFIX, PERMISSIONS_JIRA_URL, isContractorEmail };
