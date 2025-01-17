const web3Gnosis = require('web3');
const ethers = require('ethers');
const numberToBN = require('number-to-bn');
const hgUtils = require('./hg-utils.js');
const hgRegistry = require('./hg-registry.js');
const pmsContractJson = require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem');

const ONE_BN = numberToBN(1);

function HG(contractAddress) {
  var provider;
  var registry;
  var contract;
  var showGasCosts = false;

  if (typeof window === 'undefined') {
    provider = new ethers.providers.Web3Provider(web3.currentProvider);
  } else {
    provider = new ethers.providers.Web3Provider(window.web3.currentProvider);
  }
  let signer = provider.getSigner();


  this.getProvider = function() {
    return provider;
  };

  async function initContract () {
    let factory = new ethers.ContractFactory(pmsContractJson.abi, pmsContractJson.bytecode, provider.getSigner());
    contract = await factory.deploy();
    this.contract = contract;
  };

  contract = new ethers.Contract(contractAddress, pmsContractJson.abi, provider.getSigner());
  this.contract = contract;


  this.getRegistry = function() {
    if (!registry) {
      registry = new hgRegistry(this.contract, this.getProvider());
    }
    return registry;
  }

  this.getConditions = function() {
   this.getRegistry().getConditions();
  };

  this.getPositions = function() {
    this.getRegistry().getPositions();
  };

  var logGasCosts = async function(tx, label) {
    if (showGasCosts) {
      let receipt = await provider.getTransactionReceipt(tx.hash);
      console.log("Costs of " + label + " : " + receipt.gasUsed.toString());
    }
  };

  this.prepareCondition = async function(name, oracle, outcomeSlotsCount) {
    let bytesName = ethers.utils.formatBytes32String(name);
    await contract.prepareCondition(oracle, bytesName, outcomeSlotsCount);
    return new Condition(oracle, bytesName, outcomeSlotsCount);
  };

  this.createCondition = function(oracle, questionId, outcomesSlotsCount) {
    return new Condition(oracle, questionId, outcomesSlotsCount);
  };

  this.createPosition = function(condition, indexSet, collateralAddress, parent) {
    return new Position(condition, indexSet, collateralAddress, parent);
  };





  function Position(condition, indexSet, collateralAddress, parent) {
    this.condition = condition;
    this.indexSet = indexSet;
    this.collateralAddress = collateralAddress;
    this.parent = parent;
    let ownParentCollectionId = parent ? parent.collectionId : ethers.constants.HashZero;

    this.collectionId = hgUtils.getCollectionId(ownParentCollectionId, condition.id, this.indexSet);
    this.id = hgUtils.getPositionId(this.collectionId, this.collateralAddress);
    this.parentCollectionId = ownParentCollectionId;

    this.balanceOf = async function(account) {
      let balance = await contract.balanceOf(account, this.id);
      return numberToBN(balance);
    };

    this.fullSplit = async function(condition, amount) {
      return condition.fullSplit(this.collateralAddress, amount, this);
    };

    this.split = async function(condition, amount, indexSet) {
      return condition.split(this.collateralAddress, indexSet, amount, this);
    };

    this.redeem = async function(parentCollectionId = ownParentCollectionId, condition = this.condition, indexSet = this.indexSet) {
      let tx = await contract.redeemPositions(this.collateralAddress, parentCollectionId, condition.id, [indexSet]);
    }

  }

  function Condition(oracle, questionId, outcomesSlotsCount) {
    this.oracle = oracle;
    this.questionId = questionId;
    this.outcomesSlotsCount = outcomesSlotsCount;
    this.id = hgUtils.getConditionId(oracle, questionId, outcomesSlotsCount);
    var oracleProxy;

    var findOracleProxy = async function(oracleAddress) {
      for(let i=0;i<2; i++) {
        try {
          let signer = provider.getSigner(i);
          let address = await signer.getAddress();

          if (address == oracleAddress) {
            oracleProxy = contract.connect(signer);
            break
          }
        } catch (e) {
          break;
        }
      }
    };

    this.split = async function(collateralAddress, indexSet, amount, parent) {
      let parentCollectionId = parent ? parent.collectionId : ethers.constants.HashZero;
      let tx = await contract.splitPosition(collateralAddress, parentCollectionId, this.id, indexSet, amount);
      await logGasCosts(tx, 'split');
      return indexSet.map( (index) => {
        return new Position(this, index, collateralAddress, parent);
      });
    };

    this.fullSplit = async function(collateralAddress, amount, parent) {
      var indexSet = hgUtils.generateFullIndex(this.outcomesSlotsCount);
      return this.split(collateralAddress, indexSet, amount, parent);
    };

    this.rawMerge = async function(collateralAddress, indexSet, amount, parent) {
      let tx = await contract.mergePositions(collateralAddress, parent ? parent.collectionId : ethers.constants.HashZero, this.id, indexSet, amount);
      await logGasCosts(tx, 'merge');
    };

    this.merge = async function(positions, amount) {
      var collateralAddress = null;
      var indexSet = [];
      var fullIndexSet = (ONE_BN.shln(this.outcomesSlotsCount)).sub(ONE_BN);
      var freeIndexSet = fullIndexSet.clone();
      positions.forEach( (position) => {
        if (collateralAddress && collateralAddress != position.collateralAddress) {
          throw "All of the positions to merge must have the same collateral";
        } else {
          collateralAddress = position.collateralAddress;
          let indexBN = numberToBN(position.indexSet);
          indexSet.push(indexBN);
          freeIndexSet = freeIndexSet.xor(indexBN);
        }
      });
      indexSet = indexSet.map(x => ethers.utils.bigNumberify(x.toString()));
      await this.rawMerge(collateralAddress, indexSet, amount, positions[0].parent);
      return freeIndexSet.isZero() ? (positions[0].parent ? positions[0].parent : null) : new Position(this, fullIndexSet.xor(freeIndexSet), collateralAddress);
    };

    this.mergeAll = async function(collateralAddress, amount) {
      var indexSet = hgUtils.generateFullIndex(this.outcomesSlotsCount);
      return this.rawMerge(collateralAddress, indexSet, amount);
    };

    this.receiveResult = async function(result) {
      await findOracleProxy(this.oracle);
      let resultsSet = hgUtils.formatResult(result);
      return await oracleProxy.receiveResult(this.questionId, resultsSet);
    };

    //For debug purposes
    this.printAllPositions = async function(address, collateralAddress) {
      for(var i=0; i<1<<outcomesSlotsCount; i++) {
        let position = new Position(this, i, collateralAddress);
        let b = await position.balanceOf(address);
        console.log(i + " : " + b.toString());
      }
    }
  }
};


module.exports = HG;
