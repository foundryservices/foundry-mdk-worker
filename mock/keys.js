'use strict'

// Public test fixtures for the mock. They do not work against Foundry.
module.exports = {
  subAccount: 'test',
  apiKey: 'test-api-key',
  // Authenticates, but is refused on the balance, earnings and transaction routes.
  technicianKey: 'test-technician-key',
  pat: 'fdpat_test-personal-access-token'
}
