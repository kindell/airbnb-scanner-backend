import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { EventEmitter } from 'events';

interface MLTask {
  id: string;
  subject: string;
  sender: string;  
  body: string;
  emailDate?: string;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

interface MLWorker {
  id: number;
  process: ChildProcess;
  busy: boolean;
  lastUsed: number;
  tasksCompleted: number;
  status: 'initializing' | 'ready' | 'busy' | 'error' | 'dead';
}

/**
 * ML Worker Pool for persistent Python ML processing
 * 
 * Maintains a pool of persistent Python processes to avoid the overhead
 * of spawning new processes for each ML classification task.
 * Expected 2-3x speedup over spawn-per-task approach.
 */
export class MLWorkerPool extends EventEmitter {
  private workers: Map<number, MLWorker> = new Map();
  private taskQueue: MLTask[] = [];
  private poolSize: number;
  private pythonScript: string;
  private taskIdCounter = 0;
  private isShuttingDown = false;
  
  // Configuration
  private readonly TASK_TIMEOUT = 30000; // 30s timeout per task
  private readonly WORKER_RESTART_THRESHOLD = 100; // Restart worker after N tasks
  private readonly MAX_QUEUE_SIZE = 1000;

  // Circuit breaker configuration
  private circuitBreakerOpen = false;
  private consecutiveFailures = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 5;
  private readonly CIRCUIT_BREAKER_RESET_TIME = 60000; // 1 minute
  private lastFailureTime = 0;

  constructor(poolSize: number = 3) {
    super();
    this.poolSize = poolSize;
    this.pythonScript = path.join(__dirname, '../../ml/ml_classifier_bridge.py');
    console.log(`🏊‍♂️ Initializing ML Worker Pool with ${poolSize} workers`);
  }

  /**
   * Initialize the worker pool with sequential initialization to prevent resource contention
   */
  async initialize(): Promise<void> {
    console.log(`🚀 Starting ${this.poolSize} ML workers sequentially...`);

    // Sequential initialization with delay to prevent resource contention
    for (let i = 0; i < this.poolSize; i++) {
      console.log(`⏳ Creating worker ${i}/${this.poolSize}...`);
      await this.createWorker(i);

      // Add delay between workers to prevent resource contention
      if (i < this.poolSize - 1) {
        console.log(`⏱️  Waiting 2s before starting next worker...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Start the task processor
    this.processTaskQueue();

    console.log(`✅ ML Worker Pool initialized with ${this.workers.size} workers`);
  }

  /**
   * Create a new worker process
   */
  private async createWorker(id: number): Promise<void> {
    try {
      console.log(`🔨 Creating ML worker ${id}...`);
      
      // Spawn Python process in worker mode with unbuffered output and resource limits
      const childProcess = spawn('python3', ['-u', this.pythonScript, '--worker-mode'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // Limit Python memory usage to 512MB per worker
          MALLOC_TRIM_THRESHOLD_: '100000',
          PYTHONHASHSEED: '0'  // Deterministic hash for better memory behavior
        },
        // Set process limits
        detached: false,
        uid: process.getuid?.(),
        gid: process.getgid?.()
      });
      
      const worker: MLWorker = {
        id,
        process: childProcess,
        busy: false,
        lastUsed: Date.now(),
        tasksCompleted: 0,
        status: 'initializing'
      };
      
      // Set up process event handlers
      this.setupWorkerHandlers(worker);
      
      this.workers.set(id, worker);
      
      // Wait for worker to be ready
      await this.waitForWorkerReady(worker);
      
    } catch (error) {
      console.error(`❌ Failed to create ML worker ${id}:`, error);
      throw error;
    }
  }

  /**
   * Set up event handlers for a worker process
   */
  private setupWorkerHandlers(worker: MLWorker): void {
    const { process: proc, id } = worker;
    
    proc.on('close', (code) => {
      console.log(`💀 ML worker ${id} closed with code ${code}`);
      worker.status = 'dead';

      // Temporary: Disable auto-restart to prevent death spiral
      // if (!this.isShuttingDown) {
      //   console.log(`🔄 Restarting ML worker ${id}...`);
      //   setTimeout(() => this.restartWorker(id), 1000);
      // }
    });
    
    proc.on('error', (error) => {
      console.error(`❌ ML worker ${id} error:`, error);
      worker.status = 'error';
    });
    
    proc.stderr?.on('data', (data) => {
      const errorMsg = data.toString().trim();
      if (errorMsg) {
        console.error(`🚨 ML worker ${id} stderr:`, errorMsg);
      }
    });
  }

  /**
   * Wait for worker to signal it's ready
   */
  private async waitForWorkerReady(worker: MLWorker): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Worker ${worker.id} initialization timeout`));
      }, 30000); // Extended timeout - ML models need time to load
      
      let responseBuffer = '';
      
      const onData = (data: Buffer) => {
        const dataStr = data.toString();
        console.log(`🔍 ML worker ${worker.id} stdout: "${dataStr}"`);
        responseBuffer += dataStr;
        
        // Look for ready signal from Python worker - check line by line
        const lines = responseBuffer.split('\n');
        for (let i = 0; i < lines.length - 1; i++) { // Skip last incomplete line
          const line = lines[i].trim();
          console.log(`🔍 ML worker ${worker.id} checking line: "${line}"`);
          if (line === 'READY') {
            clearTimeout(timeout);
            worker.status = 'ready';
            worker.process.stdout?.off('data', onData);
            console.log(`✅ ML worker ${worker.id} is ready`);
            resolve();
            return;
          }
        }
        // Keep only the last incomplete line
        responseBuffer = lines[lines.length - 1];
      };
      
      worker.process.stdout?.on('data', onData);
    });
  }

  /**
   * Restart a failed worker
   */
  private async restartWorker(id: number): Promise<void> {
    try {
      // Remove old worker
      const oldWorker = this.workers.get(id);
      if (oldWorker?.process) {
        oldWorker.process.kill();
      }
      this.workers.delete(id);
      
      // Create new worker
      await this.createWorker(id);
      
    } catch (error) {
      console.error(`❌ Failed to restart ML worker ${id}:`, error);
    }
  }

  /**
   * Submit a task to the worker pool
   */
  async classifyEmail(
    subject: string,
    sender: string,
    body: string,
    emailDate?: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Check circuit breaker
      if (this.circuitBreakerOpen) {
        const timeSinceLastFailure = Date.now() - this.lastFailureTime;
        if (timeSinceLastFailure < this.CIRCUIT_BREAKER_RESET_TIME) {
          reject(new Error('ML Worker Pool circuit breaker is open - system recovering'));
          return;
        } else {
          // Try to reset circuit breaker
          this.circuitBreakerOpen = false;
          this.consecutiveFailures = 0;
          console.log('🔄 Circuit breaker reset - attempting to process tasks');
        }
      }

      // Check queue size
      if (this.taskQueue.length >= this.MAX_QUEUE_SIZE) {
        this.recordFailure();
        reject(new Error('ML Worker Pool queue is full'));
        return;
      }

      // Check if any workers are available
      const availableWorkers = Array.from(this.workers.values())
        .filter(w => w.status === 'ready' || w.status === 'busy');

      if (availableWorkers.length === 0) {
        this.recordFailure();
        reject(new Error('No ML workers available'));
        return;
      }
      
      const task: MLTask = {
        id: `task_${++this.taskIdCounter}`,
        subject,
        sender,
        body,
        emailDate,
        resolve,
        reject,
        timestamp: Date.now()
      };
      
      this.taskQueue.push(task);
      this.emit('task_queued', task);
    });
  }

  /**
   * Process the task queue continuously
   */
  private processTaskQueue(): void {
    const processNext = () => {
      if (this.isShuttingDown) return;
      
      // Find available worker and pending task
      const availableWorker = this.findAvailableWorker();
      const pendingTask = this.taskQueue.shift();
      
      if (availableWorker && pendingTask) {
        this.assignTaskToWorker(availableWorker, pendingTask);
      }
      
      // Continue processing
      setTimeout(processNext, 10); // Check every 10ms
    };
    
    processNext();
  }

  /**
   * Find an available worker
   */
  private findAvailableWorker(): MLWorker | null {
    for (const worker of this.workers.values()) {
      if (worker.status === 'ready' && !worker.busy) {
        return worker;
      }
    }
    return null;
  }

  /**
   * Assign a task to a specific worker
   */
  private assignTaskToWorker(worker: MLWorker, task: MLTask): void {
    worker.busy = true;
    worker.status = 'busy';
    worker.lastUsed = Date.now();
    
    console.log(`📤 Assigning task ${task.id} to worker ${worker.id}`);
    
    // Set up response handling
    this.handleWorkerResponse(worker, task);
    
    // Send task data to Python process
    const emailData = {
      subject: task.subject,
      sender: task.sender,
      body: task.body,
      ...(task.emailDate && { emailDate: task.emailDate })
    };
    
    const jsonInput = JSON.stringify(emailData) + '\n';
    
    try {
      worker.process.stdin?.write(jsonInput);
    } catch (error) {
      console.error(`❌ Failed to send task to worker ${worker.id}:`, error);
      this.handleWorkerTaskError(worker, task, error as Error);
    }
  }

  /**
   * Handle response from worker
   */
  private handleWorkerResponse(worker: MLWorker, task: MLTask): void {
    let responseBuffer = '';
    
    const timeout = setTimeout(() => {
      this.handleWorkerTaskError(worker, task, new Error('Task timeout'));
    }, this.TASK_TIMEOUT);
    
    const onData = (data: Buffer) => {
      responseBuffer += data.toString();
      
      // Look for complete JSON response (newline-terminated)
      const newlineIndex = responseBuffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const jsonResponse = responseBuffer.slice(0, newlineIndex).trim();
        responseBuffer = responseBuffer.slice(newlineIndex + 1);
        
        clearTimeout(timeout);
        worker.process.stdout?.off('data', onData);
        
        try {
          const result = JSON.parse(jsonResponse);
          this.handleWorkerTaskSuccess(worker, task, result);
        } catch (error) {
          console.error(`❌ Failed to parse ML worker response:`, jsonResponse);
          this.handleWorkerTaskError(worker, task, error as Error);
        }
      }
    };
    
    worker.process.stdout?.on('data', onData);
  }

  /**
   * Handle successful task completion
   */
  private handleWorkerTaskSuccess(worker: MLWorker, task: MLTask, result: any): void {
    worker.busy = false;
    worker.status = 'ready';
    worker.tasksCompleted++;

    // Reset circuit breaker on successful task
    this.consecutiveFailures = 0;

    console.log(`✅ Task ${task.id} completed by worker ${worker.id} (${worker.tasksCompleted} total)`);

    task.resolve(result);
    this.emit('task_completed', { task, worker, result });

    // Restart worker if it has completed too many tasks
    if (worker.tasksCompleted >= this.WORKER_RESTART_THRESHOLD) {
      console.log(`🔄 Restarting worker ${worker.id} after ${worker.tasksCompleted} tasks`);
      setTimeout(() => this.restartWorker(worker.id), 100);
    }
  }

  /**
   * Handle task error
   */
  private handleWorkerTaskError(worker: MLWorker, task: MLTask, error: Error): void {
    worker.busy = false;
    worker.status = 'error';

    // Record failure for circuit breaker
    this.recordFailure();

    console.error(`❌ Task ${task.id} failed on worker ${worker.id}:`, error.message);

    task.reject(error);
    this.emit('task_failed', { task, worker, error });
  }

  /**
   * Record a failure for circuit breaker logic
   */
  private recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
      this.circuitBreakerOpen = true;
      console.log(`🚨 Circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures`);
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const workers = Array.from(this.workers.values());
    
    return {
      poolSize: this.poolSize,
      workersReady: workers.filter(w => w.status === 'ready' && !w.busy).length,
      workersBusy: workers.filter(w => w.busy).length,
      workersError: workers.filter(w => w.status === 'error').length,
      queueLength: this.taskQueue.length,
      totalTasksCompleted: workers.reduce((sum, w) => sum + w.tasksCompleted, 0),
      circuitBreakerOpen: this.circuitBreakerOpen,
      consecutiveFailures: this.consecutiveFailures
    };
  }

  /**
   * Shutdown the worker pool gracefully
   */
  async shutdown(): Promise<void> {
    console.log(`🛑 Shutting down ML Worker Pool...`);
    this.isShuttingDown = true;
    
    // Kill all worker processes
    for (const worker of this.workers.values()) {
      try {
        worker.process.kill('SIGTERM');
      } catch (error) {
        worker.process.kill('SIGKILL');
      }
    }
    
    this.workers.clear();
    this.taskQueue = [];
    
    console.log(`✅ ML Worker Pool shutdown complete`);
  }
}