import * as _ from 'lodash';
import * as vscode from 'vscode';
import {ModeName, Mode} from './mode';
import {showCmdLine} from './../cmd_line/main';
import {Caret, Operator, VimOperation, Cursor, RequestInput, Root, StopRequestingInput, ChangeMode} from './../motion/motion';
import {KeyState, KeyParser} from '../keyState';

export default class CommandMode extends Mode {
    private caret : Caret = new Caret();
	private cursor : Cursor = new Cursor();
	private operator : Operator = new Operator();
	private normal : { [key: string] : KeyParser } = {};
	private operatorPending : { [key: string] : KeyParser } = {};
	private ops : Root = new Root();

	constructor() {
		super(ModeName.Normal);
		
		this.normal = {
			"d": (state) => { return this.operation(this.operator.delete())(state); },
			"y": (state) => { return this.operation(this.operator.copy())(state); },
			// this one needs to change modes; we could insert an i ourselves?
			"c": (state) => { return this.operationChangingMode(this.operator.delete())(state); },
			"u": (state) => { return this.terminal(this.operator.undo())(state); },
			"dd": (state) => { return this.terminal(this.operator.delete(this.cursor.fullLine()))(state); },
			"yy": (state) => { return this.terminal(this.operator.copy(this.cursor.fullLine()))(state); },
			">>": (state) => { return this.terminal(null)(state); },
			"<<": (state) => { return this.terminal(null)(state); },
			"C": (state) => { return this.terminal(null)(state); },
			"S": (state) => { return this.terminal(null)(state); },
			"D": (state) => { return this.terminal(this.operator.delete(this.cursor.lineEnd()))(state); },
			"x": (state) => { return this.terminal(this.operator.delete())(state); },
			"X": (state) => { return this.terminal(null)(state); },
			"w": (state) => { return this.terminal(this.caret.wordRight())(state); },
			"h": (state) => { return this.terminal(this.caret.left())(state); },
			"j": (state) => { return this.terminal(this.caret.down())(state); },
			"k": (state) => { return this.terminal(this.caret.up())(state); },			
			"l": (state) => { return this.terminal(this.caret.right())(state); },
			"b": (state) => { return this.terminal(this.caret.wordLeft())(state); },
			"B": (state) => { return this.terminal(this.caret.wordLeft())(state); },
			"W": (state) => { return this.terminal(this.caret.wordRight())(state); },
			"f": (state) => { return this.terminalAcceptingOneArg(null)(state); },
			"t": (state) => { return this.terminalAcceptingArgsUntilCr(null)(state); }
		}		
		
		this.operatorPending = {
			"aw": (state) => { return this.terminal(this.caret.wordRight().selecting())(state); },
			"a": (state) => { return this.textObject()(state); },
			"w": (state) => { return this.terminal(this.caret.wordRight().selecting())(state); },
			"h": (state) => { return this.terminal(this.caret.left().selecting())(state); },
			"j": (state) => { return this.terminal(this.caret.down().selecting())(state); },
			"k": (state) => { return this.terminal(this.caret.up().selecting())(state); },			
			"l": (state) => { return this.terminal(this.caret.right().selecting())(state); },
			"b": (state) => { return this.terminal(this.caret.wordLeft().selecting())(state); },
			"B": (state) => { return this.terminal(this.caret.wordLeft().selecting())(state); },
			"W": (state) => { return this.terminal(this.caret.wordRight().selecting())(state); },
			"f": (state) => { return this.terminalAcceptingOneArg(null)(state); },
			"t": (state) => { return this.terminalAcceptingArgsUntilCr(null)(state); } // example
		}
	}
	
	// parses an incomplete operation, like d
	private operation(operation: VimOperation) : KeyParser {
		this.ops.push(operation);
		return (state : KeyState) => {
			if (state.isAtEof) {
				this.ops.push(new RequestInput());
				return null;
			} else {
				return this.handleOperatorPending(state);
			}			
		}
	}

	// parses an incomplete operation, like c
	private operationChangingMode(operation: VimOperation) : KeyParser {
		this.ops.push(operation);
		return (state : KeyState) => {
			this.ops.push(new ChangeMode('i'));
			if (state.isAtEof) {
				this.ops.push(new RequestInput());
				return null;
			} else {
				return this.handleOperatorPending(state);
			}			
		}
	}	

	// parses an operation that can stand on its own, like w or dd
	private terminal(operation : VimOperation) : KeyParser {
		this.ops.push(operation);
		return (state : KeyState) =>  {
			this.ops.push(new StopRequestingInput());
			return null;			
		}
	}
	
	// parses a text object like i or a
	private textObject() : KeyParser {
		return (state : KeyState) =>  {
			state.backup();
			const prev = state.next();
			if (state.isAtEof) {
				this.ops.push(new RequestInput());
				return null;
			}
			this.ops.push(new StopRequestingInput());
			const arg = state.next();
			const m = this.operatorPending[prev + arg];
			if (m) {
				return m(state);
			}
			state.errors.push("bad text object");
			return null;		
		}
	}

	// parses an operation that can stand on its own but requires a 1 char argument
	private terminalAcceptingOneArg(name : VimOperation) : KeyParser {
		return (state : KeyState) =>  {
			if (state.isAtEof) {
				this.ops.push(new RequestInput());
				return null;
			}
			this.ops.push(new StopRequestingInput());
			const arg = state.next();
			// TODO: must add arg here.
			this.ops.push(name);
			return null;		
		}
	}
	
	// parses an operation that can stand on its own but requires an arbitrary long argument
	private terminalAcceptingArgsUntilCr(name : VimOperation) : KeyParser {
		return (state : KeyState) =>  {
			let args = "";
			let c : string;
			while (!state.isAtEof) {
				let c = state.next();
				if (c === "x") { // should be <cr> instead
					this.ops.push(new StopRequestingInput());
					// TODO: must add args here.
					this.ops.push(name); 
					return null;
				}
				args = args + c;
			}
			this.ops = new Root();
			this.ops.push(new RequestInput());
			return null;		
		}
	}

	// parses keys in operator pending mode
	private handleOperatorPending(state : KeyState) : KeyParser {
		const o = this.operatorPending[state.next()];
		if (o) {
			return o(state);
		}		
		const oo = this.normal[state.cumulative()];
		if (oo) {
			this.ops = new Root();
			return oo(state);
		}		
		state.errors.push("unknown command");
	}		

	// starting point for parsing keys in this mode
	private handleOperatorOrMotion(state : KeyState) : KeyParser {
		const c = state.next();
		if (this.shouldRequestModeChange(c)) {
			this.ops.push(new ChangeMode(c));
			return null;
		}
		var o = this.normal[c];
		if (o) {
			return o(state);
		}		
		return null;
	}

	// receives keys
	handleKeys(state :KeyState) : void {
		let f = (x) => { return this.handleOperatorOrMotion(x) };
		while (f) {
			f = f(state);
			if (state.nextMode || state.requesInput || state.errors.length > 0) {
				this.ops = new Root();
				this.caret.reset();
				return;
			}
		}		
		this.eval(state);
	}
	
	// run a command if available
	private eval(state : KeyState) {
		// this.caret.reset();		
		this.ops.execute(state);
		this.ops = new Root();
	}

	ShouldBeActivated(key : string, currentMode : ModeName) : boolean {
		return (key === 'esc' || key === 'ctrl+[');
	}
	
	private shouldRequestModeChange(key : string) : boolean {
		return (key === 'i' || key === 'I' || key === 'a' || key === 'A' || key === 'o' || key === 'O');
	}	

	HandleActivation(key : string) : Thenable<{}> {
		return Promise.resolve(this.caret.reset().left().move());
	}

	HandleKeyEvent(key : string) : Thenable<{}> {
		return null;
	}

/*
    private CommandDelete(n: number) : void {
        let pos = Caret.currentPosition();
        let end = pos.translate(0, n);
        let range : vscode.Range = new vscode.Range(pos, end);
        TextEditor.delete(range).then(function() {
			let lineEnd = Caret.lineEnd();

			if (pos.character === lineEnd.character + 1) {
				Caret.move(Caret.left());
			}
		});
    }
*/
}
