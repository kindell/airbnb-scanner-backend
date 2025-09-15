#!/usr/bin/env node

/**
 * Isolated test to reproduce ML Worker initialization timeout issue
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 Testing ML Worker initialization issue...\n');

// Same exact parameters as MLWorkerPool
const pythonScript = path.join(__dirname, 'ml/ml_classifier_bridge.py');
const startTime = Date.now();

console.log(`📍 Python script path: ${pythonScript}`);
console.log(`📍 Working directory: ${__dirname}`);

// Create the child process exactly like MLWorkerPool does
const childProcess = spawn('python3', ['-u', pythonScript, '--worker-mode'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONUNBUFFERED: '1' },
  cwd: __dirname
});

console.log(`🚀 Started Python process PID: ${childProcess.pid}\n`);

// Track what we receive
let responseBuffer = '';
let readyReceived = false;
let initializationTime = null;

// Set up the same timeout as MLWorkerPool
const timeout = setTimeout(() => {
  const elapsed = Date.now() - startTime;
  console.error(`❌ TIMEOUT after ${elapsed}ms - no READY signal received`);
  console.error(`📊 Response buffer so far: "${responseBuffer}"`);
  childProcess.kill();
  process.exit(1);
}, 30000);

// Monitor stdout exactly like MLWorkerPool does
childProcess.stdout.on('data', (data) => {
  const elapsed = Date.now() - startTime;
  const dataStr = data.toString();

  console.log(`📥 [${elapsed}ms] STDOUT: "${dataStr}"`);
  responseBuffer += dataStr;

  // Check for READY signal line by line
  const lines = responseBuffer.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    console.log(`🔍 [${elapsed}ms] Checking line: "${line}"`);

    if (line === 'READY') {
      clearTimeout(timeout);
      readyReceived = true;
      initializationTime = elapsed;
      console.log(`✅ [${elapsed}ms] READY signal received! Initialization successful.`);

      // Test sending a simple task
      testTask();
      return;
    }
  }

  // Keep only the last incomplete line
  responseBuffer = lines[lines.length - 1];
});

// Monitor stderr
childProcess.stderr.on('data', (data) => {
  const elapsed = Date.now() - startTime;
  const errorMsg = data.toString().trim();
  console.error(`🚨 [${elapsed}ms] STDERR: ${errorMsg}`);
});

// Monitor process events
childProcess.on('close', (code) => {
  const elapsed = Date.now() - startTime;
  console.log(`💀 [${elapsed}ms] Process closed with code: ${code}`);
  if (!readyReceived) {
    console.error('❌ Process closed before READY signal received');
    process.exit(1);
  }
});

childProcess.on('error', (error) => {
  const elapsed = Date.now() - startTime;
  console.error(`❌ [${elapsed}ms] Process error:`, error);
  process.exit(1);
});

// Test function to send a task after READY
function testTask() {
  console.log('\n🧪 Testing simple classification task...');

  // Prepare test email data
  const testEmail = {
    subject: 'Bokning bekräftad - Test Guest anländer 1 jan.',
    sender: 'noreply@airbnb.com',
    body: 'Din bokning är bekräftad. Gäst: Test Guest. Incheckning: 1 jan 2024.'
  };

  const jsonInput = JSON.stringify(testEmail) + '\n';

  // Set up response handler for task result
  let taskResponseBuffer = '';
  const taskTimeout = setTimeout(() => {
    console.error('❌ Task timeout - no response after 10 seconds');
    childProcess.kill();
    process.exit(1);
  }, 10000);

  const onTaskData = (data) => {
    taskResponseBuffer += data.toString();

    // Look for complete JSON response
    const newlineIndex = taskResponseBuffer.indexOf('\n');
    if (newlineIndex !== -1) {
      const jsonResponse = taskResponseBuffer.slice(0, newlineIndex).trim();
      clearTimeout(taskTimeout);
      childProcess.stdout.off('data', onTaskData);

      try {
        const result = JSON.parse(jsonResponse);
        console.log('✅ Task completed successfully!');
        console.log('📊 Result:', JSON.stringify(result, null, 2));

        console.log(`\n🎉 All tests passed! Initialization took ${initializationTime}ms`);
        childProcess.kill();
        process.exit(0);

      } catch (error) {
        console.error('❌ Failed to parse task response:', jsonResponse);
        childProcess.kill();
        process.exit(1);
      }
    }
  };

  childProcess.stdout.on('data', onTaskData);

  // Send the task
  console.log('📤 Sending test task...');
  try {
    childProcess.stdin.write(jsonInput);
  } catch (error) {
    console.error('❌ Failed to write task to stdin:', error);
    process.exit(1);
  }
}

console.log('⏰ Waiting for READY signal (30s timeout)...\n');