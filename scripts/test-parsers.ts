import { parseFile } from '../src/client/parsers/index';

async function run() {

  // Test 1: CSV with currency
  console.log('\n--- TEST 1: CSV with currency ---');
  const csvBlob = new Blob([`name,fee\nAlice,"£1,234.56"\nBob,"£2,000.00"`], { type: 'text/csv' });
  const csvFile = new File([csvBlob], 'test.csv');
  const csvResult = await parseFile(csvFile);
  if (csvResult?.fullRows?.[0]) {
    console.log('✅ CSV record[0]:', csvResult.fullRows[0]);
    console.log('   fee type:', typeof csvResult.fullRows[0].fee, '— should be number');
    console.log('   fee value:', csvResult.fullRows[0].fee, '— should be 1234.56');
  } else {
    console.log('❌ No rows. parseErrors:', csvResult?.parseErrors);
  }

  // Test 2: JSON array
  console.log('\n--- TEST 2: JSON array ---');
  const jsonBlob = new Blob([JSON.stringify([{ id: 1, name: 'Alice' }])], { type: 'application/json' });
  const jsonFile = new File([jsonBlob], 'test.json');
  const jsonResult = await parseFile(jsonFile);
  if (jsonResult?.fullRows?.[0]) {
    console.log('✅ JSON record[0]:', jsonResult.fullRows[0]);
    const idCol = jsonResult.columns.find(c => c.originalHeader === 'id');
    if (idCol?.detectedType === 'boolean') {
      console.log('⚠️  BUG: id column detected as boolean instead of number — flag to Claude Code');
    } else {
      console.log('   id detectedType:', idCol?.detectedType, '— should be number');
    }
  } else {
    console.log('❌ No rows. parseErrors:', jsonResult?.parseErrors);
  }

  // Test 3: Empty rows stripped
  console.log('\n--- TEST 3: Empty rows stripped ---');
  const csvWithEmpties = new Blob([`a,b\n1,2\n,,\n3,4`], { type: 'text/csv' });
  const emptyFile = new File([csvWithEmpties], 'empties.csv');
  const emptyResult = await parseFile(emptyFile);
  if (emptyResult?.rowCount === 2) {
    console.log('✅ rowCount:', emptyResult.rowCount, '— empty row correctly stripped');
  } else {
    console.log('❌ rowCount:', emptyResult?.rowCount, '— expected 2');
  }
  const skipWarning = emptyResult?.parseErrors?.find(e => e.message.includes('empty'));
  console.log(skipWarning ? '✅ Warning logged: ' + skipWarning.message : '⚠️  No empty-row warning found');

  // Test 4: JSON with nested object (Shape B flatten)
  console.log('\n--- TEST 4: JSON nested object flatten ---');
  const nestedJson = [{ id: 1, address: { city: 'London', postcode: 'EC1A' } }];
  const nestedBlob = new Blob([JSON.stringify(nestedJson)], { type: 'application/json' });
  const nestedFile = new File([nestedBlob], 'nested.json');
  const nestedResult = await parseFile(nestedFile);
  if (nestedResult?.fullRows?.[0]) {
    const row = nestedResult.fullRows[0];
    const flattened = 'address_city' in row || 'address.city' in row;
    console.log(flattened ? '✅ Nested object flattened' : '⚠️  Nested object NOT flattened — check json-parser.ts');
    console.log('   Keys:', Object.keys(row));
  } else {
    console.log('❌ No rows.');
  }

  // Test 5: BOM stripping
  console.log('\n--- TEST 5: BOM stripping ---');
  const bomCsv = '\uFEFFname,value\nAlice,100';
  const bomBlob = new Blob([bomCsv], { type: 'text/csv' });
  const bomFile = new File([bomBlob], 'bom.csv');
  const bomResult = await parseFile(bomFile);
  if (bomResult?.fullRows?.[0]) {
    const firstKey = Object.keys(bomResult.fullRows[0])[0];
    console.log(firstKey === 'name' ? '✅ BOM stripped — first column is "name"' : '❌ BOM NOT stripped — first column is: ' + firstKey);
  } else {
    console.log('❌ No rows.');
  }

  // Summary
  console.log('\n--- SUMMARY ---');
  console.log('If all lines above show ✅, 1B-01 is verified and ready for 1B-02.');
  console.log('Any ⚠️  lines are minor issues to flag to Claude Code but are not blockers.');
  console.log('Any ❌ lines are failures that must be fixed before proceeding.');
}

run().catch(console.error);