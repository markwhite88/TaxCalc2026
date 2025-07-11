import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
import { getFirestore, doc, setDoc, collection, onSnapshot, deleteDoc } from "firebase/firestore";

// --- Firebase Configuration ---
// NOTE: These variables are placeholders and will be populated by the environment.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-tax-app';

// --- Helper Components ---
const InputField = React.memo(({ label, value, onChange, placeholder, type = 'number', isRate = false }) => (
  <div className="w-full">
    <label className="block text-sm font-medium text-gray-700 mb-1">
      {label}
    </label>
    <div className="relative">
      {!isRate && type === 'number' && <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500">$</span>}
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full pr-4 py-2 bg-gray-50 border border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 transition ${!isRate && type === 'number' ? 'pl-7' : 'pl-3'}`}
      />
      {isRate && <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">%</span>}
    </div>
  </div>
));

const StateCheckbox = React.memo(({ state, isSelected, onChange }) => (
    <label className="flex items-center space-x-2 p-2 rounded-md hover:bg-gray-100 cursor-pointer">
        <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onChange(state)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
        <span className="text-sm font-medium text-gray-800">{state}</span>
    </label>
));


// --- Tax Calculation Logic ---
const FEDERAL_BRACKETS_MFJ = [
    { rate: 0.10, min: 0, max: 23850 }, { rate: 0.12, min: 23851, max: 96950 },
    { rate: 0.22, min: 96951, max: 206700 }, { rate: 0.24, min: 206701, max: 394600 },
    { rate: 0.32, min: 394601, max: 501050 }, { rate: 0.35, min: 501051, max: 751600 },
    { rate: 0.37, min: 751601, max: Infinity },
];
const LTCG_BRACKETS_MFJ = [
  { rate: 0.00, max: 96950 }, { rate: 0.15, max: 583750 }, { rate: 0.20, max: Infinity },
];
const STANDARD_DEDUCTION_MFJ = 40000;
const SALT_CAP = 40000;
const FEDERAL_MORTGAGE_DEBT_LIMIT = 750000;
const CA_MORTGAGE_DEBT_LIMIT = 1000000;
const CA_SDI_RATE = 0.013;
const NIIT_RATE = 0.038;
const NIIT_THRESHOLD_MFJ = 250000;


const STATE_STANDARD_DEDUCTIONS_MFJ = {
    'California': 10404, 'North Carolina': 25500,
};

const STATES_WITH_LOCAL_TAX = ['Ohio'];

const STATE_TAX_DATA = {
  'California': [
    { rate: 0.01, min: 0, max: 22108 }, { rate: 0.02, min: 22109, max: 52420 },
    { rate: 0.04, min: 52421, max: 82734 }, { rate: 0.06, min: 82735, max: 114902 },
    { rate: 0.08, min: 114903, max: 145194 }, { rate: 0.093, min: 145195, max: 742568 },
    { rate: 0.103, min: 742569, max: 891080 }, { rate: 0.113, min: 891081, max: 1485132 },
    { rate: 0.123, min: 1485133, max: Infinity }
  ],
  'Colorado': [{ rate: 0.044, min: 0, max: Infinity }],
  'Ohio': [ { rate: 0.00, min: 0, max: 26050}, { rate: 0.0275, min: 26051, max: 100000}, { rate: 0.035, min: 100001, max: Infinity} ],
  'North Carolina': [{ rate: 0.0425, min: 0, max: Infinity }],
  'Texas': [], 'Florida': [],
};

const calculateTax = (income, brackets) => {
  let tax = 0;
  let remainingIncome = income;
  for (const bracket of brackets) {
    if (remainingIncome <= 0) break;
    const taxableInBracket = Math.min(remainingIncome, bracket.max - (bracket.min > 0 ? bracket.min -1 : 0));
    if (taxableInBracket > 0) { tax += taxableInBracket * bracket.rate; remainingIncome -= taxableInBracket; }
  }
  return tax;
};

const calculateMonthlyHousingCost = (amount, rate, propTax) => {
    if (!amount || !rate) return 0;
    const monthlyRate = rate / 100 / 12;
    const numberOfPayments = 30 * 12;
    const principalAndInterest = amount * (monthlyRate * Math.pow(1 + monthlyRate, numberOfPayments)) / (Math.pow(1 + monthlyRate, numberOfPayments) - 1);
    const monthlyPropTax = propTax / 12;
    return principalAndInterest + monthlyPropTax;
};


// Main App Component
export default function App() {
  const [db, setDb] = useState(null);
  const [userId, setUserId] = useState(null);
  const [income, setIncome] = useState(250000);
  const [stGains, setStGains] = useState(5000);
  const [ltGains, setLtGains] = useState(10000);
  const [hsa, setHsa] = useState(8300);
  const [k401, setK401] = useState(46000);
  const [medicalPremiums, setMedicalPremiums] = useState(6000);
  const [otherItemized, setOtherItemized] = useState(5000);
  const [selectedStates, setSelectedStates] = useState(['California', 'Ohio', 'Texas']);
  const [stateInputs, setStateInputs] = useState({
    'California': { mortgageAmount: 1000000, mortgageRate: 5.5, propertyTax: 12000 },
    'Texas': { mortgageAmount: 450000, mortgageRate: 5.8, propertyTax: 9500 },
    'Colorado': { mortgageAmount: 600000, mortgageRate: 5.6, propertyTax: 6000 },
    'Ohio': { mortgageAmount: 300000, mortgageRate: 5.9, propertyTax: 5500, localTaxRate: 2.5 },
    'North Carolina': { mortgageAmount: 400000, mortgageRate: 5.7, propertyTax: 4000 },
  });
  const [scenarioName, setScenarioName] = useState("");
  const [selectedScenario, setSelectedScenario] = useState("");
  const [savedScenarios, setSavedScenarios] = useState({});
  const [resultsByState, setResultsByState] = useState({});
  const [expandedRows, setExpandedRows] = useState({});
  
  useEffect(() => {
    if (Object.keys(firebaseConfig).length > 0) {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const auth = getAuth(app);
      setDb(firestore);
      onAuthStateChanged(auth, async (user) => {
        if (user) { setUserId(user.uid); } 
        else {
            try {
                const token = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
                if (token) { await signInWithCustomToken(auth, token); } 
                else { await signInAnonymously(auth); }
            } catch (error) { console.error("Error signing in:", error); }
        }
      });
    }
  }, []);

  useEffect(() => {
    if (db && userId) {
      const scenariosCollection = collection(db, 'artifacts', appId, 'users', userId, 'scenarios');
      const unsubscribe = onSnapshot(scenariosCollection, (snapshot) => {
        const scenariosData = {};
        snapshot.forEach(doc => { scenariosData[doc.id] = doc.data(); });
        setSavedScenarios(scenariosData);
      });
      return () => unsubscribe();
    }
  }, [db, userId]);

  const handleSaveScenario = useCallback(async () => {
    if (!db || !userId || !scenarioName) { alert("Please enter a scenario name."); return; }
    const scenarioData = { income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs };
    try {
      const scenarioDocRef = doc(db, 'artifacts', appId, 'users', userId, 'scenarios', scenarioName);
      await setDoc(scenarioDocRef, scenarioData);
      alert(`Scenario "${scenarioName}" saved!`);
      setScenarioName("");
    } catch (error) { console.error("Error saving scenario:", error); alert("Failed to save scenario."); }
  }, [db, userId, scenarioName, income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs]);

  const handleLoadScenario = useCallback((name) => {
    const scenario = savedScenarios[name];
    if (scenario) {
      setIncome(scenario.income || 250000);
      setStGains(scenario.stGains || 5000);
      setLtGains(scenario.ltGains || 10000);
      setHsa(scenario.hsa || 8300);
      setK401(scenario.k401 || 46000);
      setMedicalPremiums(scenario.medicalPremiums || 6000);
      setOtherItemized(scenario.otherItemized || 5000);
      setSelectedStates(scenario.selectedStates || ['California', 'Texas']);
      setStateInputs(scenario.stateInputs || {});
      setSelectedScenario(name);
    }
  }, [savedScenarios]);
  
  const handleDeleteScenario = useCallback(async () => {
      if (!db || !userId || !selectedScenario) { alert("Please select a scenario to delete."); return; }
      if (confirm(`Are you sure you want to delete the scenario "${selectedScenario}"?`)) {
          try {
              const scenarioDocRef = doc(db, 'artifacts', appId, 'users', userId, 'scenarios', selectedScenario);
              await deleteDoc(scenarioDocRef);
              alert(`Scenario "${selectedScenario}" deleted.`);
              setSelectedScenario("");
          } catch (error) { console.error("Error deleting scenario:", error); alert("Failed to delete scenario."); }
      }
  }, [db, userId, selectedScenario]);

  const handleStateInputChange = useCallback((state, field, value) => {
    setStateInputs(prev => ({ ...prev, [state]: { ...(prev[state] || {}), [field]: value } }));
  }, []);

  const handleStateSelection = useCallback((state) => {
    setSelectedStates(prevSelectedStates => {
        const newSelectedStates = prevSelectedStates.includes(state)
            ? prevSelectedStates.filter(s => s !== state)
            : [...prevSelectedStates, state];

        if (!stateInputs[state]) {
            setStateInputs(prev => ({ ...prev, [state]: { mortgageAmount: 500000, mortgageRate: 6.0, propertyTax: 7000, localTaxRate: 0 } }));
        }
        
        return newSelectedStates;
    });
  }, [stateInputs]);

  useEffect(() => {
    const newResults = {};
    const grossIncome = Number(income) || 0;
    const shortTermGains = Number(stGains) || 0;
    const longTermGains = Number(ltGains) || 0;
    const hsaDed = Number(hsa) || 0;
    const k401Ded = Number(k401) || 0;
    const medicalDed = Number(medicalPremiums) || 0;
    const otherItemizedVal = Number(otherItemized) || 0;
    
    const totalIncome = grossIncome + shortTermGains + longTermGains;
    const aboveTheLineDeductions = k401Ded + hsaDed + medicalDed;
    const agi = totalIncome - aboveTheLineDeductions;
    
    const ssWageBase = 182400;
    const ssTax = Math.min(grossIncome, ssWageBase) * 0.062;
    const medicareTax = grossIncome * 0.0145;
    const additionalMedicareTax = agi > 250000 ? (agi - 250000) * 0.009 : 0;
    const ficaTax = ssTax + medicareTax + additionalMedicareTax;

    selectedStates.forEach(state => {
        const currentStateInputs = stateInputs[state] || {};
        const mortgageAmountVal = Number(currentStateInputs.mortgageAmount) || 0;
        const mortgageRateVal = Number(currentStateInputs.mortgageRate) || 0;
        const propertyTaxVal = Number(currentStateInputs.propertyTax) || 0;
        const localTaxRateVal = Number(currentStateInputs.localTaxRate) / 100 || 0;
        
        const stateAgi = state === 'California' ? agi + hsaDed : agi;

        const stateMortgageDebtLimit = state === 'California' ? CA_MORTGAGE_DEBT_LIMIT : FEDERAL_MORTGAGE_DEBT_LIMIT;
        const stateDeductibleMortgagePrincipal = Math.min(mortgageAmountVal, stateMortgageDebtLimit);
        const stateAnnualMortgageInterest = stateDeductibleMortgagePrincipal * (mortgageRateVal / 100);
        const federalDeductibleMortgagePrincipal = Math.min(mortgageAmountVal, FEDERAL_MORTGAGE_DEBT_LIMIT);
        const federalAnnualMortgageInterest = federalDeductibleMortgagePrincipal * (mortgageRateVal / 100);

        const stateItemizedDed = stateAnnualMortgageInterest + propertyTaxVal + otherItemizedVal;
        const stateStandardDed = STATE_STANDARD_DEDUCTIONS_MFJ[state] || 0;
        const stateDeductionToUse = Math.max(stateItemizedDed, stateStandardDed);
        const stateTaxableIncome = Math.max(0, stateAgi - stateDeductionToUse);
        const stateTax = calculateTax(stateTaxableIncome, STATE_TAX_DATA[state] || []);
        const sdiTax = state === 'California' ? grossIncome * CA_SDI_RATE : 0;
        const localTax = localTaxRateVal > 0 ? agi * localTaxRateVal : 0;
        
        let totalSaltPaid = stateTax + propertyTaxVal + sdiTax + localTax;
        const cappedSalt = Math.min(totalSaltPaid, SALT_CAP);
        const totalFederalItemizedDeductions = federalAnnualMortgageInterest + cappedSalt + otherItemizedVal;
        const deductionToUse = Math.max(totalFederalItemizedDeductions, STANDARD_DEDUCTION_MFJ);
        
        const federalTaxableIncome = Math.max(0, agi - deductionToUse);
        const ordinaryIncome = federalTaxableIncome - longTermGains;
        const ordinaryTax = calculateTax(ordinaryIncome, FEDERAL_BRACKETS_MFJ);
        let capitalGainsTax = 0;
        let remainingLTCG = longTermGains;
        const zeroRateMax = LTCG_BRACKETS_MFJ[0].max;
        const taxableAtZero = Math.min(remainingLTCG, Math.max(0, zeroRateMax - ordinaryIncome));
        remainingLTCG -= taxableAtZero;
        const fifteenRateMax = LTCG_BRACKETS_MFJ[1].max;
        const taxableAtFifteen = Math.min(remainingLTCG, Math.max(0, fifteenRateMax - Math.max(zeroRateMax, ordinaryIncome)));
        capitalGainsTax += taxableAtFifteen * 0.15;
        remainingLTCG -= taxableAtFifteen;
        if (remainingLTCG > 0) { capitalGainsTax += remainingLTCG * 0.20; }
        
        const netInvestmentIncome = shortTermGains + longTermGains;
        const niitBase = Math.max(0, Math.min(netInvestmentIncome, agi - NIIT_THRESHOLD_MFJ));
        const niit = niitBase * NIIT_RATE;

        const totalFederalTax = ordinaryTax + capitalGainsTax + niit;

        const totalTaxBurden = totalFederalTax + ficaTax + stateTax + sdiTax + localTax;
        const effectiveTaxRate = totalIncome > 0 ? (totalTaxBurden / totalIncome) * 100 : 0;
        
        const annualTakeHome = totalIncome - totalTaxBurden - k401Ded - hsaDed - medicalDed;
        const monthlyTakeHome = annualTakeHome / 12;
        const monthlyHousingCost = calculateMonthlyHousingCost(mortgageAmountVal, mortgageRateVal, propertyTaxVal);
        const monthlyNetCash = monthlyTakeHome - monthlyHousingCost;
        
        newResults[state] = {
            totalTaxBurden, effectiveTaxRate, annualTakeHome, monthlyTakeHome,
            totalFederalTax, ficaTax, stateTax, sdiTax, localTax, niit, agi,
            deductionToUse, federalTaxableIncome, stateTaxableIncome, totalSaltPaid, monthlyHousingCost, monthlyNetCash,
            itemized: {
                mortgageInterest: federalAnnualMortgageInterest,
                salt: cappedSalt,
                other: otherItemizedVal,
                stateIncomeTax: stateTax,
                propertyTax: propertyTaxVal,
            },
            stateStandardDed
        };
    });
    setResultsByState(newResults);
  }, [income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs]);

  const formatCurrency = (value) => {
    if (typeof value !== 'number') return '$0.00';
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  };

  const toggleRow = (key) => {
    setExpandedRows(prev => ({...prev, [key]: !prev[key]}));
  };

  const metrics = [
      { key: 'annualTakeHome', label: 'Annual Take-Home' },
      { key: 'monthlyTakeHome', label: 'Avg. Monthly Take-Home' },
      { key: 'monthlyHousingCost', label: 'Est. Monthly Housing' },
      { key: 'monthlyNetCash', label: 'Monthly Net After Housing' },
      { key: 'totalTaxBurden', label: 'Total Tax Burden', expandable: true },
      { key: 'agi', label: 'Adjusted Gross Income' },
      { key: 'federalTaxableIncome', label: 'Federal Taxable Income' },
      { key: 'stateTaxableIncome', label: 'State Taxable Income' },
      { key: 'deductionToUse', label: 'Total Fed Deduction', expandable: true },
      { key: 'totalSaltPaid', label: 'Total SALT Paid (Uncapped)' },
  ];

  return (
    <div className="bg-gray-50 min-h-screen font-sans p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-gray-800">2026 Tax Scenario Comparator</h1>
          <p className="mt-2 text-lg text-gray-600">Compare tax burdens based on the "Tax Simplification Act of 2025".</p>
        </header>
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 bg-white p-6 rounded-xl shadow-lg border border-gray-200">
            <div className="space-y-5">
              <div className="p-4 border border-indigo-200 bg-indigo-50 rounded-lg">
                <h3 className="text-xl font-semibold text-indigo-800 mb-3">Scenario Management</h3>
                <div className="space-y-3">
                  <InputField label="New Scenario Name" type="text" value={scenarioName} onChange={setScenarioName} placeholder="e.g., High Income CA" />
                  <button onClick={handleSaveScenario} className="w-full bg-indigo-600 text-white font-bold py-2 px-4 rounded-md hover:bg-indigo-700 transition">Save Scenario</button>
                  <div className="flex items-center space-x-2">
                    <select value={selectedScenario} onChange={(e) => handleLoadScenario(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md bg-white">
                      <option value="" disabled>Load a Scenario...</option>
                      {Object.keys(savedScenarios).map(name => <option key={name} value={name}>{name}</option>)}
                    </select>
                    <button onClick={handleDeleteScenario} disabled={!selectedScenario} className="p-2 bg-red-500 text-white rounded-md hover:bg-red-600 disabled:bg-red-300 transition">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
                    </button>
                  </div>
                </div>
              </div>

              <h2 className="text-2xl font-semibold text-gray-800 border-b pb-3 pt-4">Your Financial Inputs</h2>
              <InputField label="Combined Annual Income" value={income} onChange={setIncome} placeholder="e.g., 250000" />
              <InputField label="Short-Term Capital Gains" value={stGains} onChange={setStGains} placeholder="e.g., 5000" />
              <InputField label="Long-Term Capital Gains" value={ltGains} onChange={setLtGains} placeholder="e.g., 10000" />
              <h3 className="text-xl font-semibold text-gray-700 pt-4 border-t mt-4">Pre-Tax Deductions</h3>
              <InputField label="401(k) Contributions" value={k401} onChange={setK401} placeholder="e.g., 46000" />
              <InputField label="HSA Contributions" value={hsa} onChange={setHsa} placeholder="e.g., 8300" />
              <InputField label="Annual Medical Premiums" value={medicalPremiums} onChange={setMedicalPremiums} placeholder="e.g., 6000" />
              <InputField label="Other Itemized (Charity, etc.)" value={otherItemized} onChange={setOtherItemized} placeholder="e.g., 5000" />

              <div className="w-full pt-4 border-t mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Compare States of Residence</label>
                <div className="grid grid-cols-2 gap-2">
                    {Object.keys(STATE_TAX_DATA).map(s => <StateCheckbox key={s} state={s} isSelected={selectedStates.includes(s)} onChange={handleStateSelection} />)}
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 space-y-8">
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
                <h2 className="text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">State Comparison Summary</h2>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Metric</th>
                                {selectedStates.map(state => <th key={state} className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">{state}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {metrics.map((metric) => (
                                <React.Fragment key={metric.key}>
                                    <tr className={expandedRows[metric.key] ? 'bg-indigo-50' : (metrics.indexOf(metric) % 2 === 0 ? 'bg-white' : 'bg-gray-50')}>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                            {metric.expandable && (
                                                <button onClick={() => toggleRow(metric.key)} className="mr-2 text-indigo-600">
                                                    {expandedRows[metric.key] ? '[-]' : '[+]'}
                                                </button>
                                            )}
                                            {metric.label}
                                        </td>
                                        {selectedStates.map(state => (
                                            <td key={state} className="px-6 py-4 whitespace-nowrap text-sm text-gray-700 text-right font-mono">
                                                {metric.isPercent ? `${resultsByState[state]?.[metric.key]?.toFixed(2) || '0.00'}%` : formatCurrency(resultsByState[state]?.[metric.key])}
                                            </td>
                                        ))}
                                    </tr>
                                    {metric.expandable && expandedRows[metric.key] && (
                                        <>
                                            {metric.key === 'totalTaxBurden' && (
                                                <>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600">Federal Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.totalFederalTax - resultsByState[s]?.niit)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600">NIIT</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.niit)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600">FICA</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.ficaTax)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600">State Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.stateTax)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600">Local Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.localTax)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600">CA SDI Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.sdiTax)}</td>)}</tr>
                                                </>
                                            )}
                                            {metric.key === 'deductionToUse' && (
                                                 <>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600 font-semibold">Itemized Total</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm font-semibold">{formatCurrency(resultsByState[s]?.itemized.mortgageInterest + resultsByState[s]?.itemized.salt + resultsByState[s]?.itemized.other)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-16 pr-6 py-2 text-sm text-gray-500">Mortgage Interest</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.itemized.mortgageInterest)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-16 pr-6 py-2 text-sm text-gray-500">
                                                        <button onClick={() => toggleRow('saltDetail')} className="mr-2 text-indigo-600 text-xs">{expandedRows['saltDetail'] ? '[-]' : '[+]'}</button>
                                                        SALT (Capped)
                                                    </td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.itemized.salt)}</td>)}</tr>
                                                    {expandedRows['saltDetail'] && (
                                                        <>
                                                            <tr className="bg-gray-200"><td className="pl-20 pr-6 py-1 text-xs text-gray-500">State Income Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.itemized.stateIncomeTax)}</td>)}</tr>
                                                            <tr className="bg-gray-200"><td className="pl-20 pr-6 py-1 text-xs text-gray-500">Property Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.itemized.propertyTax)}</td>)}</tr>
                                                            <tr className="bg-gray-200"><td className="pl-20 pr-6 py-1 text-xs text-gray-500">Local Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.localTax)}</td>)}</tr>
                                                            <tr className="bg-gray-200"><td className="pl-20 pr-6 py-1 text-xs text-gray-500">CA SDI Tax</td>{selectedStates.map(s => <td key={s} className="px-6 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.sdiTax)}</td>)}</tr>
                                                        </>
                                                    )}
                                                    <tr className="bg-gray-100"><td className="pl-16 pr-6 py-2 text-sm text-gray-500">Other</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.itemized.other)}</td>)}</tr>
                                                    <tr className="bg-gray-100"><td className="pl-12 pr-6 py-2 text-sm text-gray-600 font-semibold">State Standard</td>{selectedStates.map(s => <td key={s} className="px-6 py-2 text-right font-mono text-sm font-semibold">{formatCurrency(resultsByState[s]?.stateStandardDed)}</td>)}</tr>
                                                </>
                                            )}
                                        </>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
                {selectedStates.length === 0 && (<div className="text-center py-10 text-gray-500"><p>Please select one or more states to see a comparison.</p></div>)}
            </div>
            
            {selectedStates.length > 0 && (
                <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
                    <h2 className="text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">State-Specific Details</h2>
                    <div className="flex overflow-x-auto space-x-4 pb-4 -mx-6 px-6">
                        {selectedStates.map(state => (
                            <div key={state} className="p-4 border border-gray-200 rounded-lg flex-shrink-0 w-64 bg-gray-50 shadow-sm">
                                <h4 className="text-lg font-semibold text-indigo-700 mb-4 text-center">{state}</h4>
                                <div className="space-y-3">
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Mortgage Amount</label>
                                        <div className="relative"><span className="absolute inset-y-0 left-0 pl-2 flex items-center text-gray-500 text-xs">$</span><input type="number" value={stateInputs[state]?.mortgageAmount || ''} onChange={(e) => handleStateInputChange(state, 'mortgageAmount', e.target.value)} className="w-full pl-5 pr-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm"/></div>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Mortgage Interest Rate</label>
                                        <div className="relative"><input type="number" value={stateInputs[state]?.mortgageRate || ''} onChange={(e) => handleStateInputChange(state, 'mortgageRate', e.target.value)} className="w-full px-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm"/><span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 text-xs">%</span></div>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Annual Property Tax</label>
                                        <div className="relative"><span className="absolute inset-y-0 left-0 pl-2 flex items-center text-gray-500 text-xs">$</span><input type="number" value={stateInputs[state]?.propertyTax || ''} onChange={(e) => handleStateInputChange(state, 'propertyTax', e.target.value)} className="w-full pl-5 pr-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm"/></div>
                                    </div>
                                    {STATES_WITH_LOCAL_TAX.includes(state) && (
                                        <div>
                                            <label className="block text-xs font-medium text-gray-600 mb-1">Est. Local Income Tax Rate</label>
                                            <div className="relative"><input type="number" value={stateInputs[state]?.localTaxRate || ''} onChange={(e) => handleStateInputChange(state, 'localTaxRate', e.target.value)} className="w-full px-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm"/><span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 text-xs">%</span></div>
                                        </div>
                                    )}
                                </div>
                                <div className="mt-4 pt-4 border-t border-gray-200">
                                    <p className="text-sm font-medium text-gray-600">Est. Monthly Housing Cost</p>
                                    <p className="text-2xl font-bold text-gray-800">{formatCurrency(calculateMonthlyHousingCost(stateInputs[state]?.mortgageAmount, stateInputs[state]?.mortgageRate, stateInputs[state]?.propertyTax))}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
