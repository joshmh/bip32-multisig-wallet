var assert = require('assert')

var bitcoin = require('bitcoinjs-lib')
var bip32utils = require('bip32-utils')
var typeForce = require('typeforce')
var selectInputs = require('./selection')

/*

TODO: Need to revamp this:
  - Move signing to MultisigAccount
  - Move JSON dump/load to MultisigAccount

*/

function Wallet (account) {
  this.account = account
  this.unspents = []
}

Wallet.fromJSON = function(json) {
  var wallet = new Wallet(bip32utils.MultisigAccount.fromJSON(json.account))
  wallet.unspents = json.unspents

  return wallet
}

/*
// TODO: Needs to be modified to take array of seeds
Wallet.fromSeedBuffer = function(seed, network) {
  network = network || networks.bitcoin

  // HD first-level child derivation method should be hardened
  // See https://bitcointalk.org/index.php?topic=405179.msg4415254#msg4415254
  var m = bitcoin.HDNode.fromSeedBuffer(seed, network)
  var i = m.deriveHardened(0)
  var external = i.derive(0)
  var internal = i.derive(1)

  return new Wallet(external, internal)
}
*/

Wallet.prototype.createTransaction = function(outputs) {
  var network = this.getNetwork()

  // filter un-confirmed
  var unspents = this.unspents.filter(function(unspent) {
    return unspent.confirmations > 0
  })

  var selection = selectInputs(unspents, outputs, network)
  var inputs = selection.inputs

  // sanity check (until things are battle tested)
  var totalInputValue = inputs.reduce(function(a, x) { return a + x.value }, 0)
  var totalOutputValue = outputs.reduce(function(a, x) { return a + x.value }, 0)
  assert.equal(totalInputValue - totalOutputValue, selection.change + selection.fee)

  // ensure fee isn't crazy (max 0.1 BTC)
  assert(selection.fee < 0.1 * 1e8, 'Very high fee: ' + selection.fee)

  // build transaction
  var txb = new bitcoin.TransactionBuilder()

  inputs.forEach(function(input) {
    txb.addInput(input.txId, input.vout)
  })

  outputs.forEach(function(output) {
    txb.addOutput(output.address, output.value)
  })

  var change, fee

  // is the change worth it?
  if (selection.change > network.dustThreshold) {
    var changeAddress = this.getChangeAddress()

    txb.addOutput(changeAddress, selection.change)

    change = selection.change
    fee = selection.fee
  } else {
    change = 0
    fee = selection.change + selection.fee
  }

  return {
    fee: fee,
    change: change,
    transaction: txb
  }
}

Wallet.prototype.containsAddress = function(address) { return this.account.containsAddress(address) }
Wallet.prototype.discover = function(gapLimit, queryCallback, done) {
  function discoverChain (iterator, callback) {
    bip32utils.discovery(iterator, gapLimit, queryCallback, function(err, used, checked) {
      if (err) return callback(err)

      // throw away ALL unused addresses AFTER the last unused address
      var unused = checked - used
      for (var i = 1; i < unused; ++i) iterator.pop()

      return callback()
    })
  }

  var external = this.account.external
  var internal = this.account.internal

  discoverChain(external, function(err) {
    if (err) return done(err)

    discoverChain(internal, done)
  })
}
Wallet.prototype.getAllAddresses = function() { return this.account.getAllAddresses() }
Wallet.prototype.getBalance = function() {
  return this.unspents.reduce(function(accum, unspent) {
    return accum + unspent.value
  }, 0)
}
Wallet.prototype.getChangeAddress = function() { return this.account.getInternalAddress() }
Wallet.prototype.getConfirmedBalance = function() {
  return this.unspents.filter(function(unspent) {
    return unspent.confirmations > 0
  }).reduce(function(accum, unspent) {
    return accum + unspent.value
  }, 0)
}
Wallet.prototype.getNetwork = function() { return this.account.getNetwork() }
Wallet.prototype.getReceiveAddress = function() { return this.account.getExternalAddress() }
Wallet.prototype.isChangeAddress = function(address) { return this.account.isInternalAddress(address) }
Wallet.prototype.isReceiveAddress = function(address) { return this.account.isExternalAddress(address) }
Wallet.prototype.nextChangeAddress = function() { return this.account.nextInternalAddress() }
Wallet.prototype.nextReceiveAddress = function() { return this.account.nextExternalAddress() }

Wallet.prototype.setUnspentOutputs = function(unspents) {
  var seen = {}

  unspents.forEach(function(unspent) {
    var txId = unspent.txId

    typeForce({
      txId: 'String',
      confirmations: 'Number',
      address: 'String',
      value: 'Number',
      vout: 'Number'
    }, unspent)

    assert.equal(txId.length, 64, 'Expected valid txId, got ' + txId)

    var shortId = txId + ':' + unspent.vout
    assert(!(shortId in seen), 'Duplicate unspent ' + shortId)
    seen[shortId] = true

    try {
      bitcoin.Address.fromBase58Check(unspent.address)
    } catch (e) {
      throw ('Expected valid base58 Address, got ' + unspent.address)
    }
  })

  this.unspents = unspents
}

Wallet.prototype.sign = function(tx, addresses, external, internal) {
  return this.account.sign(tx, addresses, external, internal)
}

Wallet.prototype.toJSON = function() {
  return {
    account: this.account.toJSON(),
    unspents: this.unspents
  }
}

module.exports = Wallet
