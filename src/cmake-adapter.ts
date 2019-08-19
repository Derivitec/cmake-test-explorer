/**
 * @file CMake test adapter
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
  TestAdapter,
  TestLoadStartedEvent,
  TestLoadFinishedEvent,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  TestSuiteEvent,
  TestEvent,
  TestSuiteInfo,
  TestInfo,
  RetireEvent,
} from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { CmakeTestInfo } from './interfaces/cmake-test-info';
import { CmakeTestResult } from './interfaces/cmake-test-result';
import { CmakeTestProcess } from './interfaces/cmake-test-process';
import {
  loadCmakeTests,
  scheduleCmakeTest,
  executeCmakeTest,
  cancelCmakeTest,
} from './cmake-runner';

/** Special ID value for the root suite */
const ROOT_SUITE_ID = '*';

/**
 * CMake test adapter for the Test Explorer UI extension
 */
export class CmakeAdapter implements TestAdapter {
  private disposables: { dispose(): void }[] = [];

  /** Discovered CMake tests */
  private cmakeTests: CmakeTestInfo[] = [];

  /** State */
  private state: 'idle' | 'loading' | 'running' | 'cancelled' = 'idle';

  /** Currently running test */
  private currentTest?: CmakeTestProcess;

  //
  // TestAdapter implementations
  //

  private readonly testsEmitter = new vscode.EventEmitter<
    TestLoadStartedEvent | TestLoadFinishedEvent
  >();
  private readonly testStatesEmitter = new vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >();
  private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();
  private readonly autorunEmitter = new vscode.EventEmitter<void>();

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }
  get testStates(): vscode.Event<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  > {
    return this.testStatesEmitter.event;
  }
  get retire(): vscode.Event<RetireEvent> | undefined {
    return this.retireEmitter.event;
  }
  get autorun(): vscode.Event<void> | undefined {
    return this.autorunEmitter.event;
  }

  constructor(
    public readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly log: Log
  ) {
    this.log.info('Initializing CMake test adapter');

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.autorunEmitter);
  }

  async load(): Promise<void> {
    if (this.state !== 'idle') return; // it is safe to ignore a call to `load()`, even if it comes directly from the Test Explorer

    this.state = 'loading';
    this.log.info('Loading CMake tests');
    this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

    try {
      const buildDir =
        vscode.workspace
          .getConfiguration('cmakeExplorer', this.workspaceFolder.uri)
          .get<string>('buildDir') || '';
      const dir = path.resolve(this.workspaceFolder.uri.fsPath, buildDir);
      this.cmakeTests = await loadCmakeTests(dir);

      const suite: TestSuiteInfo = {
        type: 'suite',
        id: ROOT_SUITE_ID,
        label: 'CMake', // the label of the root node should be the name of the testing framework
        children: [],
      };

      for (let test of this.cmakeTests) {
        const testInfo: TestInfo = {
          type: 'test',
          id: test.name,
          label: test.name,
        };
        suite.children.push(testInfo);
      }

      this.testsEmitter.fire(<TestLoadFinishedEvent>{
        type: 'finished',
        suite,
      });
    } catch (e) {
      this.testsEmitter.fire(<TestLoadFinishedEvent>{
        type: 'finished',
        errorMessage: e.toString(),
      });
    }

    this.state = 'idle';
  }

  async run(tests: string[]): Promise<void> {
    if (this.state !== 'idle') return; // it is safe to ignore a call to `run()`

    this.state = 'running';
    this.log.info(`Running CMake tests ${JSON.stringify(tests)}`);
    this.testStatesEmitter.fire(<TestRunStartedEvent>{
      type: 'started',
      tests,
    });

    try {
      for (const id of tests) {
        await this.runTest(id);
      }
    } catch (e) {
      // Fail silently
    }

    this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
    this.state = 'idle';
  }

  /*	implement this method if your TestAdapter supports debugging tests
	async debug(tests: string[]): Promise<void> {
		// start a test run in a child process and attach the debugger to it...
	}
*/

  cancel(): void {
    if (this.state !== 'running') return; // ignore

    if (this.currentTest) cancelCmakeTest(this.currentTest);

    // State will eventually transition to idle once the run loop completes
    this.state = 'cancelled';
  }

  dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /**
   * Run a single test or test suite
   *
   * @param id Test or suite ID
   */
  private async runTest(id: string) {
    if (this.state === 'cancelled') {
      // Test run cancelled, retire test
      this.retireEmitter.fire(<RetireEvent>{ tests: [id] });
      return;
    }

    if (id === ROOT_SUITE_ID) {
      // Run the whole test suite
      this.testStatesEmitter.fire(<TestSuiteEvent>{
        type: 'suite',
        suite: id,
        state: 'running',
      });
      for (const test of this.cmakeTests) {
        await this.runTest(test.name);
      }
      this.testStatesEmitter.fire(<TestSuiteEvent>{
        type: 'suite',
        suite: id,
        state: 'completed',
      });

      return;
    }

    //
    // Single test
    //

    const test = this.cmakeTests.find(test => test.name === id);
    if (!test) {
      // Not found, mark test as skipped.
      this.testStatesEmitter.fire(<TestEvent>{
        type: 'test',
        test: id,
        state: 'skipped',
      });
      return;
    }

    // Run test
    this.testStatesEmitter.fire(<TestEvent>{
      type: 'test',
      test: id,
      state: 'running',
    });
    try {
      this.currentTest = scheduleCmakeTest(test);
      const result: CmakeTestResult = await executeCmakeTest(this.currentTest);
      this.testStatesEmitter.fire(<TestEvent>{
        type: 'test',
        test: id,
        state: result.code ? 'failed' : 'passed',
        message: result.out,
      });
    } catch (e) {
      this.testStatesEmitter.fire(<TestEvent>{
        type: 'test',
        test: id,
        state: 'errored',
        message: e.toString(),
      });
    } finally {
      this.currentTest = undefined;
    }
  }
}
