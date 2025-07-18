﻿import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, LabelList, LineChart, Line, Legend } from 'recharts';

// --- Tax Calculation Logic (unchanged except standard deduction) ---
const FEDERAL_BRACKETS_MFJ = [
    { rate: 0.10, min: 0, max: 23850 }, { rate: 0.12, min: 23851, max: 96950 },
    { rate: 0.22, min: 96951, max: 206700 }, { rate: 0.24, min: 206701, max: 394600 },
    { rate: 0.32, min: 394601, max: 501050 }, { rate: 0.35, min: 501051, max: 751600 },
    { rate: 0.37, min: 751601, max: Infinity },
];
const LTCG_BRACKETS_MFJ = [
    { rate: 0.00, max: 96950 }, { rate: 0.15, max: 583750 }, { rate: 0.20, max: Infinity },
];
const FEDERAL_STANDARD_DEDUCTION_MFJ = 31500; // Updated for 2026 per user
const SALT_CAP = 40000;
const FEDERAL_MORTGAGE_DEBT_LIMIT = 750000;
const CA_MORTGAGE_DEBT_LIMIT = 1000000;
const CA_SDI_RATE = 0.013;
const NIIT_RATE = 0.038;
const NIIT_THRESHOLD_MFJ = 250000;

const STATE_STANDARD_DEDUCTIONS_MFJ = {
    'California': 10404, 'North Carolina': 25500,
    // If other states have standard deductions, add them here as needed.
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
    'Ohio': [{ rate: 0.00, min: 0, max: 26050 }, { rate: 0.0275, min: 26051, max: 100000 }, { rate: 0.035, min: 100001, max: Infinity }],
    'North Carolina': [{ rate: 0.0425, min: 0, max: Infinity }],
    'Texas': [], 'Florida': [],
};
const STATE_ABBREVIATIONS = {
    'California': 'CA', 'Colorado': 'CO', 'Ohio': 'OH',
    'North Carolina': 'NC', 'Texas': 'TX', 'Florida': 'FL'
};
const calculateTax = (income, brackets) => {
    let tax = 0;
    let remainingIncome = income;
    for (const bracket of brackets) {
        if (remainingIncome <= 0) break;
        const taxableInBracket = Math.min(remainingIncome, bracket.max - (bracket.min > 0 ? bracket.min - 1 : 0));
        if (taxableInBracket > 0) { tax += taxableInBracket * bracket.rate; remainingIncome -= taxableInBracket; }
    }
    return tax;
};
const calculateMonthlyHousingCost = (amount, rate, propTax, insurance) => {
    if (!amount || !rate) return 0;
    const monthlyRate = rate / 100 / 12;
    const numberOfPayments = 30 * 12;
    const principalAndInterest = amount * (monthlyRate * Math.pow(1 + monthlyRate, numberOfPayments)) / (Math.pow(1 + monthlyRate, numberOfPayments) - 1);
    const monthlyPropTax = (propTax || 0) / 12;
    const monthlyInsurance = (insurance || 0) / 12;
    return principalAndInterest + monthlyPropTax + monthlyInsurance;
};
// CORRECTED: getInterestSchedule for table display (full mortgage amount, not capped)
function getInterestSchedule({ amount, annualRate, years = 10 }) {
    if (!amount || !annualRate) return [];
    const n = 30 * 12;
    const r = annualRate / 100 / 12;
    const monthlyPayment = amount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    let balance = amount;
    let yearInterest = Array(years).fill(0);
    for (let i = 0; i < years * 12 && balance > 0; i++) {
        const interest = balance * r;
        const yearIdx = Math.floor(i / 12);
        if (yearIdx < years) yearInterest[yearIdx] += interest;
        const principal = monthlyPayment - interest;
        balance -= principal;
    }
    return yearInterest.map((interest, idx) => ({ year: idx + 1, interest }));
}
const formatCurrency = (value, digits = 0) => {
    if (typeof value !== 'number' || isNaN(value)) return '$0';
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits });
};
function calcMonthlyTakeHomeDelta({
    origDeduction,
    newDeduction,
    agi,
    federalTaxableIncome,
    totalIncome,
    shortTermGains,
    longTermGains,
    k401Ded,
    hsaDed,
    medicalDed,
    ficaTax,
    stateTax,
    sdiTax,
    localTax,
    niit,
    totalFederalTax,
}) {
    const newFedTaxableIncome = Math.max(0, agi - newDeduction);
    const ordinaryIncome = newFedTaxableIncome - longTermGains;
    const newOrdinaryTax = calculateTax(ordinaryIncome, FEDERAL_BRACKETS_MFJ);

    // LTCG tax
    let remainingLTCG = longTermGains;
    const zeroRateMax = LTCG_BRACKETS_MFJ[0].max;
    const fifteenRateMax = LTCG_BRACKETS_MFJ[1].max;
    const taxableAtZero = Math.min(remainingLTCG, Math.max(0, zeroRateMax - ordinaryIncome));
    remainingLTCG -= taxableAtZero;
    const taxableAtFifteen = Math.min(remainingLTCG, Math.max(0, fifteenRateMax - Math.max(zeroRateMax, ordinaryIncome)));
    let newCapitalGainsTax = taxableAtFifteen * 0.15;
    remainingLTCG -= taxableAtFifteen;
    if (remainingLTCG > 0) {
        newCapitalGainsTax += remainingLTCG * 0.20;
    }

    // NIIT
    const netInvestmentIncome = shortTermGains + longTermGains;
    const niitBase = Math.max(0, Math.min(netInvestmentIncome, agi - NIIT_THRESHOLD_MFJ));
    const newNiit = niitBase * NIIT_RATE;

    const newTotalFederalTax = newOrdinaryTax + newCapitalGainsTax + newNiit;
    // All other taxes unchanged for this purpose
    const newTotalTaxBurden = newTotalFederalTax + ficaTax + stateTax + sdiTax + localTax;
    const newAnnualTakeHome = totalIncome - newTotalTaxBurden - k401Ded - hsaDed - medicalDed;
    const newMonthlyTakeHome = newAnnualTakeHome / 12;
    return newMonthlyTakeHome;
}
// Add helper to calculate state-level tax impact from deduction loss
function calcStateMonthlyTakeHomeDelta({
    origDeduction, newDeduction, agi, state, stateStandardDed, stateTaxBrackets, localTax, sdiTax
}) {
    if (!stateTaxBrackets || stateTaxBrackets.length === 0) return 0;
    const stateTaxableIncomeOrig = Math.max(0, agi - origDeduction);
    const stateTaxableIncomeNew = Math.max(0, agi - newDeduction);
    const origStateTax = calculateTax(stateTaxableIncomeOrig, stateTaxBrackets) + (sdiTax || 0) + (localTax || 0);
    const newStateTax = calculateTax(stateTaxableIncomeNew, stateTaxBrackets) + (sdiTax || 0) + (localTax || 0);
    return (origStateTax - newStateTax) / 12;
}

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

const TabButton = ({ label, isActive, onClick }) => (
    <button
        onClick={onClick}
        className={`px-3 sm:px-4 py-2 text-sm font-semibold rounded-t-lg border-b-2 transition-colors duration-200
      ${isActive
                ? 'text-indigo-600 border-indigo-600 bg-white'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`
        }
    >
        {label}
    </button>
);

// --- AnalysisCharts Component ---
const AnalysisCharts = ({ resultsByState, selectedStates }) => {
    const [baseState, setBaseState] = useState(selectedStates[0] || '');
    const [takeHomeDeltaView, setTakeHomeDeltaView] = useState('monthly');
    const [netCashDeltaView, setNetCashDeltaView] = useState('monthly');

    useEffect(() => {
        if (!selectedStates.includes(baseState) && selectedStates.length > 0) {
            setBaseState(selectedStates[0]);
        }
    }, [selectedStates, baseState]);

    const takeHomeDeltaData = selectedStates.map(state => {
        const baseValue = takeHomeDeltaView === 'monthly'
            ? (resultsByState[baseState]?.monthlyTakeHome || 0)
            : (resultsByState[baseState]?.annualTakeHome || 0);
        const stateValue = takeHomeDeltaView === 'monthly'
            ? (resultsByState[state]?.monthlyTakeHome || 0)
            : (resultsByState[state]?.annualTakeHome || 0);
        return { name: STATE_ABBREVIATIONS[state] || state, Delta: stateValue - baseValue };
    });

    // UPDATED: Now uses monthlyNetSavings
    const netSavingsDeltaData = selectedStates.map(state => {
        const baseValue = netCashDeltaView === 'monthly'
            ? (resultsByState[baseState]?.monthlyNetSavings || 0)
            : ((resultsByState[baseState]?.monthlyNetSavings || 0) * 12);
        const stateValue = netCashDeltaView === 'monthly'
            ? (resultsByState[state]?.monthlyNetSavings || 0)
            : ((resultsByState[state]?.monthlyNetSavings || 0) * 12);
        return { name: STATE_ABBREVIATIONS[state] || state, Delta: stateValue - baseValue };
    });

    const renderCustomBarLabel = ({ x, y, width, height, value }) => {
        const yPos = value >= 0 ? y - 5 : y + height + 15;
        const color = value >= 0 ? '#16a34a' : '#dc2626';
        return (
            <text x={x + width / 2} y={yPos} fill={color} textAnchor="middle" dy={0} fontSize={12} fontWeight="bold">
                {formatCurrency(value)}
            </text>
        );
    };

    return (
        <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
            <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">Scenario Analysis</h2>
            <div className="flex justify-center items-center gap-2 mb-6 text-sm">
                <label htmlFor="baseStateSelect" className="text-gray-600 font-medium">Compare Against:</label>
                <select id="baseStateSelect" value={baseState} onChange={(e) => setBaseState(e.target.value)} className="p-1 border border-gray-300 rounded-md bg-white">
                    {selectedStates.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-end">
                <div>
                    <h3 className="text-lg sm:text-xl font-semibold text-center mb-2">Net Savings Delta</h3>
                    <div className="flex justify-center items-center gap-4 mb-4 text-sm">
                        <div className="inline-flex rounded-md shadow-sm">
                            <button onClick={() => setNetCashDeltaView('monthly')} className={`px-3 py-1 text-xs font-medium rounded-l-lg border ${netCashDeltaView === 'monthly' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-600'}`}>Monthly</button>
                            <button onClick={() => setNetCashDeltaView('annual')} className={`px-3 py-1 text-xs font-medium rounded-r-lg border ${netCashDeltaView === 'annual' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-600'}`}>Annual</button>
                        </div>
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={netSavingsDeltaData} margin={{ top: 20, right: 20, left: -10, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="name" />
                            <YAxis tickFormatter={(value) => formatCurrency(value)} />
                            <Tooltip formatter={(value) => formatCurrency(value)} />
                            <ReferenceLine y={0} stroke="#000" />
                            <Bar dataKey="Delta" fill="#8884d8">
                                <LabelList dataKey="Delta" content={renderCustomBarLabel} />
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
                <div>
                    <h3 className="text-lg sm:text-xl font-semibold text-center mb-2">Take-Home Pay Delta</h3>
                    <div className="flex justify-center items-center gap-4 mb-4 text-sm">
                        <div className="inline-flex rounded-md shadow-sm">
                            <button onClick={() => setTakeHomeDeltaView('monthly')} className={`px-3 py-1 text-xs font-medium rounded-l-lg border ${takeHomeDeltaView === 'monthly' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-600'}`}>Monthly</button>
                            <button onClick={() => setTakeHomeDeltaView('annual')} className={`px-3 py-1 text-xs font-medium rounded-r-lg border ${takeHomeDeltaView === 'annual' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-600'}`}>Annual</button>
                        </div>
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={takeHomeDeltaData} margin={{ top: 20, right: 20, left: -10, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="name" />
                            <YAxis tickFormatter={(value) => formatCurrency(value)} />
                            <Tooltip formatter={(value) => formatCurrency(value)} />
                            <ReferenceLine y={0} stroke="#000" />
                            <Bar dataKey="Delta" fill="#82ca9d">
                                <LabelList dataKey="Delta" content={renderCustomBarLabel} />
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
};

// --- NEW: Cash Flow Analysis Component ---
const CashFlowAnalysis = ({ selectedStates, resultsByState, cashFlowInputs, handleCashFlowInputChange }) => {
    const expenseCategories = ['Utilities', 'Car P&I', 'Food', 'Childcare', 'Entertainment', 'Travel', 'Other'];
    return (
        <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
            <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">Cash Flow Analysis</h2>
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Metric</th>
                            {selectedStates.map(state => <th key={state} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">{state}</th>)}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                        <tr className="bg-gray-100">
                            <td className="px-4 py-3 font-semibold text-sm">Net Cash After Housing</td>
                            {selectedStates.map(state => <td key={state} className="px-4 py-3 text-right font-mono font-semibold text-sm">{formatCurrency(resultsByState[state]?.monthlyNetCash)}</td>)}
                        </tr>
                        {expenseCategories.map(cat => (
                            <tr key={cat}>
                                <td className="px-4 py-3 text-sm">{cat}</td>
                                {selectedStates.map(state => (
                                    <td key={state} className="px-4 py-2">
                                        <div className="relative">
                                            <span className="absolute inset-y-0 left-0 pl-2 flex items-center text-gray-500 text-sm">$</span>
                                            <input
                                                type="number"
                                                value={cashFlowInputs[state]?.[cat] || ''}
                                                onChange={e => handleCashFlowInputChange(state, cat, e.target.value)}
                                                className="w-full text-right pr-2 pl-5 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm"
                                                placeholder="0"
                                            />
                                        </div>
                                    </td>
                                ))}
                            </tr>
                        ))}
                        <tr className="bg-gray-100">
                            <td className="px-4 py-3 font-semibold text-sm">Total Monthly Expenses</td>
                            {selectedStates.map(state => <td key={state} className="px-4 py-3 text-right font-mono font-semibold text-sm text-red-600">{formatCurrency(resultsByState[state]?.totalMonthlyExpenses)}</td>)}
                        </tr>
                        <tr className="bg-green-100">
                            <td className="px-4 py-3 font-bold text-sm text-green-800">Final Monthly Net Savings</td>
                            {selectedStates.map(state => <td key={state} className="px-4 py-3 text-right font-mono font-bold text-sm text-green-800">{formatCurrency(resultsByState[state]?.monthlyNetSavings)}</td>)}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
};


// --- Retirement Analysis Component ---
// UPDATED: State is lifted up, now receives props for inputs and handlers
const RetirementAnalysis = ({ resultsByState, selectedStates, retirementInputs, handleRetirementInputChange }) => {
    const { portfolioGrowthRate, currentAge, retirementAge, currentAssets, baseAnnualSavings, fiNumber, swr } = retirementInputs;
    const { setPortfolioGrowthRate, setCurrentAge, setRetirementAge, setCurrentAssets, setBaseAnnualSavings, setFiNumber, setSwr } = handleRetirementInputChange;

    const [baseState, setBaseState] = useState(selectedStates[0] || '');

    useEffect(() => {
        if (!selectedStates.includes(baseState) && selectedStates.length > 0) {
            setBaseState(selectedStates[0]);
        }
    }, [selectedStates, baseState]);

    const yearsToProject = useMemo(() => Math.max(0, Number(retirementAge) - Number(currentAge)), [retirementAge, currentAge]);

    const projectionData = useMemo(() => {
        if (!baseState || !resultsByState[baseState]) return [];

        // UPDATED: Use monthlyNetSavings
        const baseAnnualNetSavings = (resultsByState[baseState].monthlyNetSavings || 0) * 12;

        return selectedStates.map(state => {
            if (!resultsByState[state]) return null;

            // UPDATED: Use monthlyNetSavings
            const stateAnnualNetSavings = (resultsByState[state].monthlyNetSavings || 0) * 12;
            const annualDifference = stateAnnualNetSavings - baseAnnualNetSavings;

            const rate = portfolioGrowthRate / 100;
            let futureValue = 0;
            let futureValueChartData = [];
            for (let i = 1; i <= yearsToProject; i++) {
                futureValue = (futureValue + annualDifference) * (1 + rate);
                futureValueChartData.push({ year: Number(currentAge) + i, value: futureValue });
            }

            return {
                state,
                annualDifference,
                futureValue,
                chartData: futureValueChartData,
            };
        }).filter(Boolean);
    }, [resultsByState, baseState, portfolioGrowthRate, currentAge, yearsToProject, selectedStates]);

    const backsolverCalculations = useMemo(() => {
        if (!baseState || !resultsByState[baseState]) return { table: [], chart: [] };

        const rate = portfolioGrowthRate / 100;
        const targetAssets = Number(fiNumber);
        // UPDATED: Use monthlyNetSavings
        const baseStateAnnualNetSavings = (resultsByState[baseState].monthlyNetSavings || 0) * 12;

        let maxYears = 0;
        const tableData = [];

        for (const state of selectedStates) {
            // UPDATED: Use monthlyNetSavings
            const stateAnnualNetSavings = (resultsByState[state]?.monthlyNetSavings || 0) * 12;
            const cashDelta = stateAnnualNetSavings - baseStateAnnualNetSavings;
            const totalAnnualContribution = Number(baseAnnualSavings) + cashDelta;

            let years = Infinity;
            if (totalAnnualContribution <= 0 && (Number(currentAssets) * rate) <= 0) {
                years = Infinity;
            } else {
                if (rate > 0) {
                    const val1 = targetAssets * rate + totalAnnualContribution;
                    const val2 = Number(currentAssets) * rate + totalAnnualContribution;
                    if (val1 > 0 && val2 > 0) {
                        years = Math.log(val1 / val2) / Math.log(1 + rate);
                    }
                } else { // Handle 0% growth rate
                    if (totalAnnualContribution > 0) {
                        years = (targetAssets - Number(currentAssets)) / totalAnnualContribution;
                    }
                }
            }

            const finalYears = years > 100 ? Infinity : years;
            if (isFinite(finalYears)) {
                maxYears = Math.max(maxYears, Math.ceil(finalYears));
            }
            tableData.push({ state, years: finalYears, totalAnnualContribution });
        }

        maxYears = Math.min(maxYears + 2, 50); // Add a buffer and cap at 50 years

        const chartData = tableData.map(({ state, totalAnnualContribution }) => {
            let series = [{ age: Number(currentAge), value: Number(currentAssets) }];
            let assets = Number(currentAssets);
            for (let i = 1; i <= maxYears; i++) {
                assets = assets * (1 + rate) + totalAnnualContribution;
                series.push({ age: Number(currentAge) + i, value: assets });
                if (assets > targetAssets) break; // Stop charting after reaching FI
            }
            return { state, data: series };
        });

        return { table: tableData, chart: chartData, maxYears };
    }, [resultsByState, selectedStates, currentAssets, fiNumber, portfolioGrowthRate, baseAnnualSavings, baseState, currentAge]);

    if (selectedStates.length < 1) {
        return (
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200">
                <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 mb-4">Retirement Projection</h2>
                <p className="text-gray-600">Please select at least one state to run retirement calculations.</p>
            </div>
        );
    }

    const annualRetirementIncome = Number(fiNumber) * (swr / 100);

    return (
        <div className="space-y-8">
            {/* Savings Projection */}
            <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
                <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">Retirement Savings Projection</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
                    <InputField label="Current Age" value={currentAge} onChange={setCurrentAge} />
                    <InputField label="Target Retirement Age" value={retirementAge} onChange={setRetirementAge} />
                    <InputField label="Portfolio Growth Rate" value={portfolioGrowthRate} onChange={setPortfolioGrowthRate} isRate={true} />
                    <div className="w-full">
                        <label htmlFor="baseStateSelectRetire" className="block text-sm font-medium text-gray-700 mb-1">Compare Against</label>
                        <select id="baseStateSelectRetire" value={baseState} onChange={(e) => setBaseState(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md bg-white">
                            {selectedStates.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>
                </div>

                {selectedStates.length > 1 && (
                    <>
                        <h3 className="text-lg sm:text-xl font-semibold text-center mb-4 mt-8">Projected Additional Savings Growth by Age {retirementAge}</h3>
                        <ResponsiveContainer width="100%" height={400}>
                            <LineChart margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" dataKey="year" domain={[Number(currentAge), Number(retirementAge)]} tickFormatter={(tick) => `Age ${tick}`} />
                                <YAxis tickFormatter={(value) => formatCurrency(value, 0)} />
                                <Tooltip formatter={(value) => formatCurrency(value, 0)} />
                                <Legend />
                                <ReferenceLine y={0} stroke="#000" />
                                {projectionData.map((data, index) => (
                                    <Line key={data.state} type="monotone" dataKey="value" data={data.chartData} name={`${data.state} vs ${baseState}`} stroke={`hsl(${index * 60}, 70%, 50%)`} strokeWidth={2} dot={false} />
                                ))}
                            </LineChart>
                        </ResponsiveContainer>

                        <div className="overflow-x-auto mt-6">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">State</th>
                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Annual Savings Difference</th>
                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Potential Value at Age {retirementAge}</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {projectionData.map(data => (
                                        data.state !== baseState && <tr key={data.state}>
                                            <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{data.state}</td>
                                            <td className={`px-4 py-4 whitespace-nowrap text-sm text-right font-mono ${data.annualDifference > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                {formatCurrency(data.annualDifference)}
                                            </td>
                                            <td className={`px-4 py-4 whitespace-nowrap text-sm text-right font-mono ${data.futureValue > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                {formatCurrency(data.futureValue)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>

            {/* Backsolver */}
            <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
                <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">Financial Independence Backsolver</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
                    <InputField label="Current Assets" value={currentAssets} onChange={setCurrentAssets} />
                    <InputField label={`Base Annual Savings (in ${baseState})`} value={baseAnnualSavings} onChange={setBaseAnnualSavings} />
                    <InputField label="FI Target Amount" value={fiNumber} onChange={setFiNumber} />
                    <InputField label="Safe Withdrawal Rate" value={swr} onChange={setSwr} isRate={true} />
                </div>

                <h3 className="text-lg sm:text-xl font-semibold text-center mb-4 mt-8">Path to Financial Independence</h3>
                <ResponsiveContainer width="100%" height={400}>
                    <LineChart margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" dataKey="age" domain={['dataMin', 'dataMax']} tickFormatter={(tick) => `Age ${tick}`} allowDecimals={false} />
                        <YAxis tickFormatter={(value) => formatCurrency(value, 0)} />
                        <Tooltip formatter={(value, name) => [formatCurrency(value, 0), name]} />
                        <Legend />
                        <ReferenceLine y={Number(fiNumber)} label={{ value: `FI Target: ${formatCurrency(fiNumber)}`, position: 'insideTopLeft' }} stroke="red" strokeDasharray="3 3" />
                        {backsolverCalculations.chart.map((series, index) => (
                            <Line key={series.state} type="monotone" dataKey="value" data={series.data} name={series.state} stroke={`hsl(${index * 60}, 70%, 50%)`} strokeWidth={2} dot={false} />
                        ))}
                    </LineChart>
                </ResponsiveContainer>

                <div className="overflow-x-auto mt-6">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">State</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Adjusted Annual Savings</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Years to FI</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Retirement Age</th>
                                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Est. Annual Income at FI</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {backsolverCalculations.table.map(res => (
                                <tr key={res.state}>
                                    <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{res.state}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-sm text-right font-mono">{formatCurrency(res.totalAnnualContribution)}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-sm text-right font-mono">{isFinite(res.years) ? res.years.toFixed(1) : 'Never'}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-sm text-right font-mono">{isFinite(res.years) ? (Number(currentAge) + res.years).toFixed(1) : 'N/A'}</td>
                                    <td className="px-4 py-4 whitespace-nowrap text-sm text-right font-mono">{formatCurrency(annualRetirementIncome)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="mt-3 text-xs text-gray-500">
                        <b>Years to FI</b> is the time it takes for your current assets, plus compounded annual savings, to reach your FI Target. Assumes a {portfolioGrowthRate}% portfolio growth rate.
                    </p>
                </div>
            </div>
        </div>
    );
};


export default function TaxCalculator() {
    const [activeView, setActiveView] = useState('comparison');
    const [showRentScenario, setShowRentScenario] = useState(true);

    const [income, setIncome] = useState(250000);
    const [stGains, setStGains] = useState(5000);
    const [ltGains, setLtGains] = useState(10000);
    const [hsa, setHsa] = useState(8300);
    const [k401, setK401] = useState(46000);
    const [medicalPremiums, setMedicalPremiums] = useState(6000);
    const [otherItemized, setOtherItemized] = useState(5000);
    const [selectedStates, setSelectedStates] = useState(['California', 'Ohio', 'Texas']);
    const [stateInputs, setStateInputs] = useState({
        'California': { mortgageAmount: 1000000, mortgageRate: 5.5, propertyTax: 12000, homeInsurance: 1500, monthlyRent: 4000 },
        'Texas': { mortgageAmount: 450000, mortgageRate: 5.8, propertyTax: 9500, homeInsurance: 2000, monthlyRent: 2500 },
        'Colorado': { mortgageAmount: 600000, mortgageRate: 5.6, propertyTax: 6000, homeInsurance: 1200, monthlyRent: 2200 },
        'Ohio': { mortgageAmount: 300000, mortgageRate: 5.9, propertyTax: 5500, localTaxRate: 2.5, homeInsurance: 1000, monthlyRent: 1800 },
        'North Carolina': { mortgageAmount: 400000, mortgageRate: 5.7, propertyTax: 4000, homeInsurance: 1100, monthlyRent: 2000 },
    });

    // NEW: State for cash flow inputs
    const [cashFlowInputs, setCashFlowInputs] = useState({});

    // NEW: State for retirement inputs is lifted up
    const [retirementInputs, setRetirementInputs] = useState({
        portfolioGrowthRate: 7, currentAge: 37, retirementAge: 50,
        currentAssets: 100000, baseAnnualSavings: 25000,
        fiNumber: 2000000, swr: 4,
    });

    const [scenarioName, setScenarioName] = useState("");
    const [selectedScenario, setSelectedScenario] = useState("");
    const [savedScenarios, setSavedScenarios] = useState({});
    const [expandedRows, setExpandedRows] = useState({});
    const [expandedSchedules, setExpandedSchedules] = useState({});

    // UPDATED: New local storage key for new data structure
    const LOCAL_STORAGE_KEY = "taxScenariosV2";

    const getStoredScenarios = () => {
        try {
            return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
        } catch {
            return {};
        }
    };
    const saveScenarios = (scenarios) => {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(scenarios));
    };

    useEffect(() => {
        setSavedScenarios(getStoredScenarios());
    }, []);

    const handleSaveScenario = useCallback(() => {
        if (!scenarioName) { alert("Please enter a scenario name."); return; }
        // UPDATED: Save all inputs including cash flow and retirement
        const scenarioData = { income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs, cashFlowInputs, retirementInputs };
        const updatedScenarios = { ...getStoredScenarios(), [scenarioName]: scenarioData };
        saveScenarios(updatedScenarios);
        setSavedScenarios(updatedScenarios);
        alert(`Scenario "${scenarioName}" saved!`);
        setScenarioName("");
    }, [scenarioName, income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs, cashFlowInputs, retirementInputs]);

    const handleLoadScenario = useCallback((name) => {
        const scenario = savedScenarios[name];
        if (scenario) {
            setIncome(scenario.income ?? 250000);
            setStGains(scenario.stGains ?? 5000);
            setLtGains(scenario.ltGains ?? 10000);
            setHsa(scenario.hsa ?? 8300);
            setK401(scenario.k401 ?? 46000);
            setMedicalPremiums(scenario.medicalPremiums ?? 6000);
            setOtherItemized(scenario.otherItemized ?? 5000);
            setSelectedStates(scenario.selectedStates ?? ['California', 'Texas']);
            setStateInputs(scenario.stateInputs ?? {});
            // UPDATED: Load cash flow and retirement inputs
            setCashFlowInputs(scenario.cashFlowInputs ?? {});
            setRetirementInputs(prev => ({ ...prev, ...(scenario.retirementInputs || {}) }));
            setSelectedScenario(name);
        }
    }, [savedScenarios]);

    const handleDeleteScenario = useCallback(() => {
        if (!selectedScenario || !window.confirm(`Are you sure you want to delete the scenario "${selectedScenario}"?`)) return;
        const updatedScenarios = { ...getStoredScenarios() };
        delete updatedScenarios[selectedScenario];
        saveScenarios(updatedScenarios);
        setSavedScenarios(updatedScenarios);
        alert(`Scenario "${selectedScenario}" deleted.`);
        setSelectedScenario("");
    }, [selectedScenario]);

    const handleUpdateScenario = useCallback(() => {
        if (!selectedScenario) {
            alert("Please select a scenario to update.");
            return;
        }
        // UPDATED: Update with all inputs
        const scenarioData = { income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs, cashFlowInputs, retirementInputs };
        const updatedScenarios = { ...getStoredScenarios(), [selectedScenario]: scenarioData };
        saveScenarios(updatedScenarios);
        setSavedScenarios(updatedScenarios);
        alert(`Scenario "${selectedScenario}" updated!`);
    }, [selectedScenario, income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs, cashFlowInputs, retirementInputs]);

    const handleStateInputChange = useCallback((state, field, value) => {
        setStateInputs(prev => ({ ...prev, [state]: { ...(prev[state] || {}), [field]: value } }));
    }, []);

    // NEW: Handler for cash flow inputs
    const handleCashFlowInputChange = useCallback((state, field, value) => {
        setCashFlowInputs(prev => ({ ...prev, [state]: { ...(prev[state] || {}), [field]: value } }));
    }, []);

    // NEW: Handlers for lifted retirement state
    const handleRetirementInputChange = useMemo(() => ({
        setPortfolioGrowthRate: (val) => setRetirementInputs(p => ({ ...p, portfolioGrowthRate: val })),
        setCurrentAge: (val) => setRetirementInputs(p => ({ ...p, currentAge: val })),
        setRetirementAge: (val) => setRetirementInputs(p => ({ ...p, retirementAge: val })),
        setCurrentAssets: (val) => setRetirementInputs(p => ({ ...p, currentAssets: val })),
        setBaseAnnualSavings: (val) => setRetirementInputs(p => ({ ...p, baseAnnualSavings: val })),
        setFiNumber: (val) => setRetirementInputs(p => ({ ...p, fiNumber: val })),
        setSwr: (val) => setRetirementInputs(p => ({ ...p, swr: val })),
    }), []);


    const handleStateSelection = useCallback((state) => {
        setSelectedStates(prevSelectedStates => {
            const newSelectedStates = prevSelectedStates.includes(state)
                ? prevSelectedStates.filter(s => s !== state)
                : [...prevSelectedStates, state];

            if (!stateInputs[state]) {
                setStateInputs(prev => ({
                    ...prev,
                    [state]: { mortgageAmount: 500000, mortgageRate: 6.0, propertyTax: 7000, homeInsurance: 1200, localTaxRate: 0, monthlyRent: 2000 }
                }));
            }

            return newSelectedStates;
        });
    }, [stateInputs]);

    // --- CALCULATION LOGIC ---
    const resultsByState = useMemo(() => {
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
            const currentCashFlowInputs = cashFlowInputs[state] || {}; // NEW
            const mortgageAmountVal = Number(currentStateInputs.mortgageAmount) || 0;
            const mortgageRateVal = Number(currentStateInputs.mortgageRate) || 0;
            const propertyTaxVal = Number(currentStateInputs.propertyTax) || 0;
            const homeInsuranceVal = Number(currentStateInputs.homeInsurance) || 0;
            const localTaxRateVal = Number(currentStateInputs.localTaxRate) / 100 || 0;
            const monthlyRentVal = Number(currentStateInputs.monthlyRent) || 0;

            // --- BUY SCENARIO ---
            const stateAgi = state === 'California' ? agi + hsaDed : agi;
            const stateMortgageDebtLimit = state === 'California' ? CA_MORTGAGE_DEBT_LIMIT : FEDERAL_MORTGAGE_DEBT_LIMIT;
            const stateDeductibleMortgagePrincipal = Math.min(mortgageAmountVal, stateMortgageDebtLimit);
            const stateAnnualMortgageInterest = getInterestSchedule({
                amount: stateDeductibleMortgagePrincipal,
                annualRate: mortgageRateVal,
                years: 1
            })[0]?.interest || 0;
            const federalDeductibleMortgagePrincipal = Math.min(mortgageAmountVal, FEDERAL_MORTGAGE_DEBT_LIMIT);
            const federalAnnualMortgageInterest = getInterestSchedule({
                amount: federalDeductibleMortgagePrincipal,
                annualRate: mortgageRateVal,
                years: 1
            })[0]?.interest || 0;

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
            const deductionToUse = Math.max(totalFederalItemizedDeductions, FEDERAL_STANDARD_DEDUCTION_MFJ);

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
            const monthlyHousingCost = calculateMonthlyHousingCost(mortgageAmountVal, mortgageRateVal, propertyTaxVal, homeInsuranceVal);
            const monthlyNetCash = monthlyTakeHome - monthlyHousingCost;

            // NEW: Calculate total expenses and final net savings
            const totalMonthlyExpenses = Object.values(currentCashFlowInputs).reduce((sum, val) => sum + (Number(val) || 0), 0);
            const monthlyNetSavings = monthlyNetCash - totalMonthlyExpenses;

            // --- RENT SCENARIO ---
            const rentStateAgi = state === 'California' ? agi + hsaDed : agi;
            const rentStateStandardDed = STATE_STANDARD_DEDUCTIONS_MFJ[state] || 0;
            const rentStateTaxableIncome = Math.max(0, rentStateAgi - rentStateStandardDed);
            const rentStateTax = calculateTax(rentStateTaxableIncome, STATE_TAX_DATA[state] || []);
            const rentSdiTax = state === 'California' ? grossIncome * CA_SDI_RATE : 0;
            const rentLocalTax = localTaxRateVal > 0 ? agi * localTaxRateVal : 0;

            let rentTotalSaltPaid = rentStateTax + rentSdiTax + rentLocalTax;
            const rentCappedSalt = Math.min(rentTotalSaltPaid, SALT_CAP);
            const rentDeductionToUse = Math.max(FEDERAL_STANDARD_DEDUCTION_MFJ, 0);
            const rentFederalTaxableIncome = Math.max(0, agi - rentDeductionToUse);
            const rentOrdinaryIncome = rentFederalTaxableIncome - longTermGains;
            const rentOrdinaryTax = calculateTax(rentOrdinaryIncome, FEDERAL_BRACKETS_MFJ);
            let rentCapitalGainsTax = 0;
            let rentRemainingLTCG = longTermGains;
            const rentTaxableAtZero = Math.min(rentRemainingLTCG, Math.max(0, zeroRateMax - rentOrdinaryIncome));
            rentRemainingLTCG -= rentTaxableAtZero;
            const rentTaxableAtFifteen = Math.min(rentRemainingLTCG, Math.max(0, fifteenRateMax - Math.max(zeroRateMax, rentOrdinaryIncome)));
            rentCapitalGainsTax += rentTaxableAtFifteen * 0.15;
            rentRemainingLTCG -= rentTaxableAtFifteen;
            if (rentRemainingLTCG > 0) { rentCapitalGainsTax += rentRemainingLTCG * 0.20; }

            const rentNetInvestmentIncome = shortTermGains + longTermGains;
            const rentNiitBase = Math.max(0, Math.min(rentNetInvestmentIncome, agi - NIIT_THRESHOLD_MFJ));
            const rentNiit = rentNiitBase * NIIT_RATE;

            const rentTotalFederalTax = rentOrdinaryTax + rentCapitalGainsTax + rentNiit;
            const rentTotalTaxBurden = rentTotalFederalTax + ficaTax + rentStateTax + rentSdiTax + rentLocalTax;
            const rentAnnualTakeHome = totalIncome - rentTotalTaxBurden - k401Ded - hsaDed - medicalDed;
            const rentMonthlyTakeHome = rentAnnualTakeHome / 12;
            const rentMonthlyHousingCost = monthlyRentVal;
            const rentMonthlyNetCash = rentMonthlyTakeHome - rentMonthlyHousingCost;

            newResults[state] = {
                // Buy scenario:
                totalTaxBurden, effectiveTaxRate, annualTakeHome, monthlyTakeHome,
                totalFederalTax, ficaTax, stateTax, sdiTax, localTax, niit, agi,
                deductionToUse, federalTaxableIncome, stateTaxableIncome, totalSaltPaid, monthlyHousingCost, monthlyNetCash,
                totalMonthlyExpenses, monthlyNetSavings, // NEW
                itemized: {
                    mortgageInterest: federalAnnualMortgageInterest,
                    salt: cappedSalt,
                    other: otherItemizedVal,
                    stateIncomeTax: stateTax,
                    propertyTax: propertyTaxVal,
                },
                stateStandardDed,
                // Rent scenario:
                rent: {
                    totalTaxBurden: rentTotalTaxBurden,
                    annualTakeHome: rentAnnualTakeHome,
                    monthlyTakeHome: rentMonthlyTakeHome,
                    monthlyHousingCost: rentMonthlyHousingCost,
                    monthlyNetCash: rentMonthlyNetCash,
                    deductionToUse: rentDeductionToUse,
                    federalTaxableIncome: rentFederalTaxableIncome,
                    stateTaxableIncome: rentStateTaxableIncome,
                    totalSaltPaid: rentTotalSaltPaid,
                    stateTax: rentStateTax,
                    sdiTax: rentSdiTax,
                    localTax: rentLocalTax,
                    niit: rentNiit,
                    stateStandardDed: rentStateStandardDed
                }
            };
        });
        return newResults;
    }, [income, stGains, ltGains, hsa, k401, medicalPremiums, otherItemized, selectedStates, stateInputs, cashFlowInputs]);

    // PATCH: Add per-year interest and take-home impact data for state cards, including state tax impact, and collapsible UI
    const perStateInterestSchedules = useMemo(() => {
        const schedules = {};
        selectedStates.forEach(state => {
            const currentStateInputs = stateInputs[state] || {};
            const mortgageAmountVal = Number(currentStateInputs.mortgageAmount) || 0;
            const mortgageRateVal = Number(currentStateInputs.mortgageRate) || 0;
            const propertyTaxVal = Number(currentStateInputs.propertyTax) || 0;
            const agi = resultsByState[state]?.agi || 0;
            const otherItemizedVal = Number(otherItemized) || 0;
            const cappedSalt = resultsByState[state]?.itemized?.salt || 0;
            const k401Ded = Number(k401) || 0;
            const hsaDed = Number(hsa) || 0;
            const medicalDed = Number(medicalPremiums) || 0;
            const ficaTax = resultsByState[state]?.ficaTax || 0;
            const stateTax = resultsByState[state]?.stateTax || 0;
            const sdiTax = resultsByState[state]?.sdiTax || 0;
            const localTax = resultsByState[state]?.localTax || 0;
            const shortTermGains = Number(stGains) || 0;
            const longTermGains = Number(ltGains) || 0;
            const totalIncome = Number(income) + shortTermGains + longTermGains;
            const origFedDeduction = resultsByState[state]?.deductionToUse || 0;
            const fedTaxableIncome = resultsByState[state]?.federalTaxableIncome || 0;
            const origMonthlyTakeHome = resultsByState[state]?.monthlyTakeHome || 0;
            const niit = resultsByState[state]?.niit || 0;
            const totalFederalTax = resultsByState[state]?.totalFederalTax || 0;
            const stateStandardDed = resultsByState[state]?.stateStandardDed || 0;
            const stateTaxBrackets = STATE_TAX_DATA[state] || [];
            // Deduction limit
            const federalDeductibleMortgagePrincipal = Math.min(mortgageAmountVal, FEDERAL_MORTGAGE_DEBT_LIMIT);
            const schedule = getInterestSchedule({ amount: federalDeductibleMortgagePrincipal, annualRate: mortgageRateVal, years: 10 });
            // For years 2-10 only
            const yearRows = [];
            for (let y = 2; y <= 10; ++y) {
                // New deduction: interest from this year + cappedSalt + otherItemized
                const thisYearInterest = schedule[y - 1]?.interest || 0;
                const newDeduction = thisYearInterest + cappedSalt + otherItemizedVal;
                const deductionUsed = Math.max(newDeduction, FEDERAL_STANDARD_DEDUCTION_MFJ);
                // Get the new monthly take-home with this deduction and compute $ impact
                const newMonthlyTakeHome = calcMonthlyTakeHomeDelta({
                    origDeduction: origFedDeduction,
                    newDeduction: deductionUsed,
                    agi,
                    federalTaxableIncome: fedTaxableIncome,
                    totalIncome,
                    shortTermGains,
                    longTermGains,
                    k401Ded,
                    hsaDed,
                    medicalDed,
                    ficaTax,
                    stateTax,
                    sdiTax,
                    localTax,
                    niit,
                    totalFederalTax,
                });
                // State impact: check if itemization drops below state standard deduction for that year
                // For state, use newDeduction capped at state standard deduction
                const stateDedUsed = Math.max(thisYearInterest + propertyTaxVal + otherItemizedVal, stateStandardDed);
                const origStateDed = Math.max(schedule[0]?.interest + propertyTaxVal + otherItemizedVal, stateStandardDed);
                const stateTaxDelta = calcStateMonthlyTakeHomeDelta({
                    origDeduction: origStateDed,
                    newDeduction: stateDedUsed,
                    agi,
                    state,
                    stateStandardDed,
                    stateTaxBrackets,
                    localTax,
                    sdiTax,
                });
                // The net dollar impact is both federal and state
                const dollarImpact = newMonthlyTakeHome - origMonthlyTakeHome + stateTaxDelta;
                yearRows.push({
                    year: y,
                    interest: thisYearInterest,
                    impact: dollarImpact
                });
            }
            schedules[state] = yearRows;
        });
        return schedules;
    }, [selectedStates, stateInputs, resultsByState, otherItemized, k401, hsa, medicalPremiums, income, stGains, ltGains]);

    const toggleRow = (key) => {
        setExpandedRows(prev => ({ ...prev, [key]: !prev[key] }));
    };

    // For your original summary/metric table
    const metrics = [
        { key: 'annualTakeHome', label: 'Annual Take-Home' },
        { key: 'monthlyTakeHome', label: 'Avg. Monthly Take-Home' },
        { key: 'monthlyHousingCost', label: 'Est. Monthly Housing (PITI)' },
        { key: 'monthlyNetCash', label: 'Monthly Net After Housing' },
        { key: 'monthlyNetSavings', label: 'Final Monthly Net Savings' }, // NEW
        { key: 'totalTaxBurden', label: 'Total Tax Burden', expandable: true },
        { key: 'agi', label: 'Adjusted Gross Income' },
        { key: 'federalTaxableIncome', label: 'Federal Taxable Income' },
        { key: 'stateTaxableIncome', label: 'State Taxable Income' },
        { key: 'deductionToUse', label: 'Total Fed Deduction', expandable: true },
        { key: 'totalSaltPaid', label: 'Total SALT Paid (Uncapped)' },
    ];

    return (
        <div className="bg-gray-50 min-h-screen font-sans p-2 sm:p-6 lg:p-8">
            <div className="max-w-screen-2xl mx-auto">
                <header className="mb-8 text-center">
                    <h1 className="text-3xl sm:text-4xl font-bold text-gray-800">2026 Tax & Retirement Comparator</h1>
                </header>
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                    {/* Left Input Pane */}
                    <div className="lg:col-span-4 xl:col-span-3 bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
                        <div className="space-y-5">
                            <div className="p-4 border border-indigo-200 bg-indigo-50 rounded-lg">
                                <h3 className="text-xl font-semibold text-indigo-800 mb-3">Scenario Management</h3>
                                <div className="space-y-3">
                                    <InputField label="New Scenario Name" type="text" value={scenarioName} onChange={setScenarioName} placeholder="e.g., High Income CA" />
                                    <button onClick={handleSaveScenario} className="w-full bg-indigo-600 text-white font-bold py-2 px-4 rounded-md hover:bg-indigo-700 transition">Save Scenario</button>
                                    <button
                                        onClick={handleUpdateScenario}
                                        disabled={!selectedScenario}
                                        className="w-full bg-yellow-400 text-white font-bold py-2 px-4 rounded-md hover:bg-yellow-500 disabled:bg-yellow-200 transition mt-2"
                                    >
                                        Update Selected Scenario
                                    </button>
                                    <div className="flex items-center space-x-2">
                                        <select value={selectedScenario} onChange={(e) => handleLoadScenario(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md bg-white">
                                            <option value="" disabled>Load a Scenario...</option>
                                            {Object.keys(savedScenarios).map(name => <option key={name} value={name}>{name}</option>)}
                                        </select>
                                        <button onClick={handleDeleteScenario} disabled={!selectedScenario} className="p-2 bg-red-500 text-white rounded-md hover:bg-red-600 disabled:bg-red-300 transition">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
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
                                <div className="mt-4">
                                    <label className="flex items-center space-x-2 p-2 rounded-md hover:bg-gray-100 cursor-pointer">
                                        <input type="checkbox" checked={showRentScenario} onChange={() => setShowRentScenario(prev => !prev)} className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                                        <span className="text-sm font-medium text-gray-800">Show Rent Scenario</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                    {/* Main Section */}
                    <div className="lg:col-span-8 xl:col-span-9 space-y-8">
                        <div className="border-b border-gray-200">
                            <nav className="-mb-px flex space-x-2 sm:space-x-6">
                                <TabButton label="State Comparison" isActive={activeView === 'comparison'} onClick={() => setActiveView('comparison')} />
                                <TabButton label="Cash Flow" isActive={activeView === 'cashflow'} onClick={() => setActiveView('cashflow')} />
                                <TabButton label="Retirement Analysis" isActive={activeView === 'retirement'} onClick={() => setActiveView('retirement')} />
                            </nav>
                        </div>

                        {activeView === 'comparison' && (
                            <>
                                {/* --- Original Main Comparison Table --- */}
                                <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
                                    <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">State Comparison Summary (Buy Scenario)</h2>
                                    <div className="overflow-x-auto">
                                        <table className="min-w-full divide-y divide-gray-200">
                                            <thead className="bg-gray-50">
                                                <tr>
                                                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Metric</th>
                                                    {selectedStates.map(state => <th key={state} className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">{state}</th>)}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {metrics.map((metric) => (
                                                    <React.Fragment key={metric.key}>
                                                        <tr className={expandedRows[metric.key] ? 'bg-indigo-50' : (metrics.indexOf(metric) % 2 === 0 ? 'bg-white' : 'bg-gray-50')}>
                                                            <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                                                {metric.expandable && (
                                                                    <button onClick={() => toggleRow(metric.key)} className="mr-2 text-indigo-600">
                                                                        {expandedRows[metric.key] ? '[-]' : '[+]'}
                                                                    </button>
                                                                )}
                                                                {metric.label}
                                                            </td>
                                                            {selectedStates.map(state => (
                                                                <td key={state} className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 text-right font-mono">
                                                                    {metric.key === 'delta'
                                                                        ? formatCurrency((resultsByState[state]?.monthlyNetCash ?? 0) - (resultsByState[state]?.rent?.monthlyNetCash ?? 0))
                                                                        : metric.key.startsWith('rent.')
                                                                            ? formatCurrency(metric.key.split('.').reduce((a, b) => a?.[b], resultsByState[state]))
                                                                            : formatCurrency(resultsByState[state]?.[metric.key])}
                                                                </td>
                                                            ))}
                                                        </tr>
                                                        {metric.expandable && expandedRows[metric.key] && (
                                                            <>
                                                                {metric.key === 'totalTaxBurden' && (
                                                                    <>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600">Federal Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.totalFederalTax - resultsByState[s]?.niit)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600">NIIT</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.niit)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600">FICA</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.ficaTax)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600">State Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.stateTax)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600">Local Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.localTax)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600">CA SDI Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.sdiTax)}</td>)}</tr>
                                                                    </>
                                                                )}
                                                                {metric.key === 'deductionToUse' && (
                                                                    <>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600 font-semibold">Itemized Total</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm font-semibold">{formatCurrency(resultsByState[s]?.itemized.mortgageInterest + resultsByState[s]?.itemized.salt + resultsByState[s]?.itemized.other)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-16 pr-4 py-2 text-sm text-gray-500">Mortgage Interest</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.itemized.mortgageInterest)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-16 pr-4 py-2 text-sm text-gray-500">
                                                                            <button onClick={() => toggleRow('saltDetail')} className="mr-2 text-indigo-600 text-xs">{expandedRows['saltDetail'] ? '[-]' : '[+]'}</button>
                                                                            SALT (Capped)
                                                                        </td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.itemized.salt)}</td>)}</tr>
                                                                        {expandedRows['saltDetail'] && (
                                                                            <>
                                                                                <tr className="bg-gray-200"><td className="pl-20 pr-4 py-1 text-xs text-gray-500">State Income Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.itemized.stateIncomeTax)}</td>)}</tr>
                                                                                <tr className="bg-gray-200"><td className="pl-20 pr-4 py-1 text-xs text-gray-500">Property Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.itemized.propertyTax)}</td>)}</tr>
                                                                                <tr className="bg-gray-200"><td className="pl-20 pr-4 py-1 text-xs text-gray-500">Local Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.localTax)}</td>)}</tr>
                                                                                <tr className="bg-gray-200"><td className="pl-20 pr-4 py-1 text-xs text-gray-500">CA SDI Tax</td>{selectedStates.map(s => <td key={s} className="px-4 py-1 text-right font-mono text-xs">{formatCurrency(resultsByState[s]?.sdiTax)}</td>)}</tr>
                                                                            </>
                                                                        )}
                                                                        <tr className="bg-gray-100"><td className="pl-16 pr-4 py-2 text-sm text-gray-500">Other</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm">{formatCurrency(resultsByState[s]?.itemized.other)}</td>)}</tr>
                                                                        <tr className="bg-gray-100"><td className="pl-12 pr-4 py-2 text-sm text-gray-600 font-semibold">State Standard</td>{selectedStates.map(s => <td key={s} className="px-4 py-2 text-right font-mono text-sm font-semibold">{formatCurrency(resultsByState[s]?.stateStandardDed)}</td>)}</tr>
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

                                {/* --- State-specific Details Panel --- */}
                                <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200">
                                    <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">State-Specific Housing & Local Inputs</h2>
                                    <div className="flex overflow-x-auto space-x-4 pb-4 -mx-4 sm:-mx-6 px-4 sm:px-6">
                                        {selectedStates.map(state => {
                                            const isExpanded = expandedSchedules[state] || false;
                                            const displaySchedule = getInterestSchedule({
                                                amount: Number(stateInputs[state]?.mortgageAmount) || 0,
                                                annualRate: Number(stateInputs[state]?.mortgageRate) || 0,
                                                years: 10,
                                            });
                                            return (
                                                <div key={state} className="p-4 border border-gray-200 rounded-lg flex-shrink-0 w-64 sm:w-72 bg-gray-50 shadow-sm">
                                                    <h4 className="text-lg font-semibold text-indigo-700 mb-4 text-center">{state}</h4>
                                                    <div className="space-y-3">
                                                        <div>
                                                            <label className="block text-xs font-medium text-gray-600 mb-1">Mortgage Amount</label>
                                                            <div className="relative"><span className="absolute inset-y-0 left-0 pl-2 flex items-center text-gray-500 text-sm">$</span><input type="number" value={stateInputs[state]?.mortgageAmount || ''} onChange={(e) => handleStateInputChange(state, 'mortgageAmount', e.target.value)} className="w-full pl-5 pr-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm" /></div>
                                                        </div>
                                                        <div>
                                                            <label className="block text-xs font-medium text-gray-600 mb-1">Mortgage Interest Rate</label>
                                                            <div className="relative"><input type="number" value={stateInputs[state]?.mortgageRate || ''} onChange={(e) => handleStateInputChange(state, 'mortgageRate', e.target.value)} className="w-full px-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm" /><span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 text-sm">%</span></div>
                                                        </div>
                                                        <div>
                                                            <label className="block text-xs font-medium text-gray-600 mb-1">Annual Property Tax</label>
                                                            <div className="relative"><span className="absolute inset-y-0 left-0 pl-2 flex items-center text-gray-500 text-sm">$</span><input type="number" value={stateInputs[state]?.propertyTax || ''} onChange={(e) => handleStateInputChange(state, 'propertyTax', e.target.value)} className="w-full pl-5 pr-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm" /></div>
                                                        </div>
                                                        <div>
                                                            <label className="block text-xs font-medium text-gray-600 mb-1">Annual Home Insurance</label>
                                                            <div className="relative"><span className="absolute inset-y-0 left-0 pl-2 flex items-center text-gray-500 text-sm">$</span><input type="number" value={stateInputs[state]?.homeInsurance || ''} onChange={(e) => handleStateInputChange(state, 'homeInsurance', e.target.value)} className="w-full pl-5 pr-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm" /></div>
                                                        </div>
                                                        {showRentScenario && (
                                                            <div>
                                                                <label className="block text-xs font-medium text-gray-600 mb-1">Estimated Monthly Rent</label>
                                                                <div className="relative">
                                                                    <span className="absolute inset-y-0 left-0 pl-2 flex items-center text-gray-500 text-sm">$</span>
                                                                    <input type="number" value={stateInputs[state]?.monthlyRent || ''} onChange={(e) => handleStateInputChange(state, 'monthlyRent', e.target.value)} className="w-full pl-5 pr-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm" />
                                                                </div>
                                                            </div>
                                                        )}
                                                        {STATES_WITH_LOCAL_TAX.includes(state) && (
                                                            <div>
                                                                <label className="block text-xs font-medium text-gray-600 mb-1">Est. Local Income Tax Rate</label>
                                                                <div className="relative"><input type="number" value={stateInputs[state]?.localTaxRate || ''} onChange={(e) => handleStateInputChange(state, 'localTaxRate', e.target.value)} className="w-full px-2 py-1 text-sm bg-white border border-gray-300 rounded-md shadow-sm" /><span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 text-sm">%</span></div>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="mt-4 pt-4 border-t border-gray-200">
                                                        <p className="text-sm font-medium text-gray-600">Est. Monthly Housing Cost (PITI)</p>
                                                        <p className="text-xl sm:text-2xl font-bold text-gray-800">
                                                            {formatCurrency(calculateMonthlyHousingCost(
                                                                stateInputs[state]?.mortgageAmount,
                                                                stateInputs[state]?.mortgageRate,
                                                                stateInputs[state]?.propertyTax,
                                                                stateInputs[state]?.homeInsurance
                                                            ))}
                                                        </p>
                                                    </div>
                                                    {/* --- Interest Schedule Table: Years 2-10 --- */}
                                                    <div className="mt-4 border-t pt-4">
                                                        <button
                                                            className="flex items-center text-xs font-semibold text-indigo-700 mb-2 hover:underline"
                                                            onClick={() =>
                                                                setExpandedSchedules(prev => ({ ...prev, [state]: !isExpanded }))
                                                            }
                                                        >
                                                            {isExpanded ? '[-]' : '[+]'} First 10 Years: Deduction Phaseout Impact
                                                        </button>
                                                        {isExpanded && (
                                                            <>
                                                                <table className="min-w-full text-xs border">
                                                                    <thead>
                                                                        <tr>
                                                                            <th className="px-2 py-1 border-b text-left">Year</th>
                                                                            <th className="px-2 py-1 border-b text-right">Interest</th>
                                                                            <th className="px-2 py-1 border-b text-right">$ Impact</th>
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {displaySchedule.slice(1, 10).map((row, idx) => {
                                                                            // Match up with perStateInterestSchedules[state][idx] (years 2-10 are indices 0-8)
                                                                            const impact = perStateInterestSchedules[state]?.[idx]?.impact;
                                                                            return (
                                                                                <tr key={row.year}>
                                                                                    <td className="px-2 py-1">{row.year}</td>
                                                                                    <td className="px-2 py-1 text-right">{formatCurrency(row.interest)}</td>
                                                                                    <td className={`px-2 py-1 text-right ${impact < 0 ? 'text-red-700' : impact > 0 ? 'text-green-700' : ''
                                                                                        }`}>
                                                                                        {impact === 0 || impact == null ? '-' : formatCurrency(impact)}
                                                                                    </td>
                                                                                </tr>
                                                                            );
                                                                        })}
                                                                    </tbody>
                                                                </table>
                                                                <p className="mt-1 text-xxs text-gray-500">
                                                                    "$ Impact" is the change in avg. monthly take-home pay vs. Year 1.
                                                                </p>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                )}
                                {/* --- AnalysisCharts and Rent vs Buy Table unchanged... */}
                                {selectedStates.length > 0 && <AnalysisCharts resultsByState={resultsByState} selectedStates={selectedStates} />}
                                {selectedStates.length > 0 && showRentScenario && (
                                    <div className="bg-white p-4 sm:p-6 rounded-xl shadow-lg border border-gray-200 mt-8">
                                        <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 border-b pb-3 mb-6">
                                            Rent vs. Buy: Net Mortgage Cost After Tax Savings
                                        </h2>
                                        <div className="overflow-x-auto">
                                            <table className="min-w-full divide-y divide-gray-200">
                                                <thead className="bg-gray-50">
                                                    <tr>
                                                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">State</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly PITI</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Tax Savings</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Net Cost</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Rent</th>
                                                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Delta</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {selectedStates.map((state) => {
                                                        const piti = resultsByState[state]?.monthlyHousingCost ?? 0;
                                                        const taxSavings =
                                                            (resultsByState[state]?.monthlyTakeHome ?? 0) -
                                                            (resultsByState[state]?.rent?.monthlyTakeHome ?? 0);
                                                        const netMortgageCost = piti - taxSavings;
                                                        const rent = resultsByState[state]?.rent?.monthlyHousingCost ?? Number(stateInputs[state]?.monthlyRent ?? 0);
                                                        const cashDelta = netMortgageCost - rent;
                                                        return (
                                                            <tr key={state} className={cashDelta > 0 ? 'bg-red-50' : cashDelta < 0 ? 'bg-green-50' : ''}>
                                                                <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{state}</td>
                                                                <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 text-right font-mono">{formatCurrency(piti)}</td>
                                                                <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 text-right font-mono">{formatCurrency(taxSavings)}</td>
                                                                <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 text-right font-mono">{formatCurrency(netMortgageCost)}</td>
                                                                <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 text-right font-mono">{formatCurrency(rent)}</td>
                                                                <td className={`px-4 py-4 whitespace-nowrap text-sm text-right font-mono ${cashDelta > 0 ? 'text-red-700' : cashDelta < 0 ? 'text-green-700' : ''}`}>
                                                                    {formatCurrency(cashDelta)}
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                        <p className="mt-3 text-xs text-gray-500">
                                            <b>Cash Delta</b> = Net Mortgage Cost minus Rent. Positive means buying is more expensive monthly.
                                        </p>
                                    </div>
                                )}
                            </>
                        )}

                        {activeView === 'cashflow' && (
                            <CashFlowAnalysis
                                selectedStates={selectedStates}
                                resultsByState={resultsByState}
                                cashFlowInputs={cashFlowInputs}
                                handleCashFlowInputChange={handleCashFlowInputChange}
                            />
                        )}

                        {activeView === 'retirement' && (
                            <RetirementAnalysis
                                resultsByState={resultsByState}
                                selectedStates={selectedStates}
                                retirementInputs={retirementInputs}
                                handleRetirementInputChange={handleRetirementInputChange}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}