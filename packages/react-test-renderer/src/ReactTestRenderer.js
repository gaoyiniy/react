/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from 'react-reconciler/src/ReactFiber';
import type {FiberRoot} from 'react-reconciler/src/ReactFiberRoot';
import type {Instance, TextInstance} from './ReactTestHostConfig';

import * as TestRenderer from 'react-reconciler/inline.test';
import {batchedUpdates} from 'events/ReactGenericBatching';
import {findCurrentFiberUsingSlowPath} from 'react-reconciler/reflection';
import {
  Fragment,
  FunctionalComponent,
  ClassComponent,
  HostComponent,
  HostPortal,
  HostText,
  HostRoot,
  ContextConsumer,
  ContextProvider,
  Mode,
  ForwardRef,
  Profiler,
} from 'shared/ReactTypeOfWork';
import invariant from 'fbjs/lib/invariant';

import * as ReactTestHostConfig from './ReactTestHostConfig';
import * as TestRendererScheduling from './ReactTestRendererScheduling';

type TestRendererOptions = {
  createNodeMock: (element: React$Element<any>) => any,
  unstable_isAsync: boolean,
};

type ReactTestRendererJSON = {|
  type: string,
  props: {[propName: string]: any},
  children: null | Array<ReactTestRendererNode>,
  $$typeof?: Symbol, // Optional because we add it with defineProperty().
|};
type ReactTestRendererNode = ReactTestRendererJSON | string;

type FindOptions = $Shape<{
  // performs a "greedy" search: if a matching node is found, will continue
  // to search within the matching node's children. (default: true)
  deep: boolean,
}>;

export type Predicate = (node: ReactTestInstance) => ?boolean;

const defaultTestOptions = {
  createNodeMock: function() {
    return null;
  },
};

function toJSON(inst: Instance | TextInstance): ReactTestRendererNode {
  switch (inst.tag) {
    case 'TEXT':
      return inst.text;
    case 'INSTANCE':
      /* eslint-disable no-unused-vars */
      // We don't include the `children` prop in JSON.
      // Instead, we will include the actual rendered children.
      const {children, ...props} = inst.props;
      /* eslint-enable */
      let renderedChildren = null;
      if (inst.children && inst.children.length) {
        renderedChildren = inst.children.map(toJSON);
      }
      const json: ReactTestRendererJSON = {
        type: inst.type,
        props: props,
        children: renderedChildren,
      };
      Object.defineProperty(json, '$$typeof', {
        value: Symbol.for('react.test.json'),
      });
      return json;
    default:
      throw new Error(`Unexpected node type in toJSON: ${inst.tag}`);
  }
}

function childrenToTree(node) {
  if (!node) {
    return null;
  }
  const children = nodeAndSiblingsArray(node);
  if (children.length === 0) {
    return null;
  } else if (children.length === 1) {
    return toTree(children[0]);
  }
  return flatten(children.map(toTree));
}

function nodeAndSiblingsArray(nodeWithSibling) {
  const array = [];
  let node = nodeWithSibling;
  while (node != null) {
    array.push(node);
    node = node.sibling;
  }
  return array;
}

function flatten(arr) {
  const result = [];
  const stack = [{i: 0, array: arr}];
  while (stack.length) {
    const n = stack.pop();
    while (n.i < n.array.length) {
      const el = n.array[n.i];
      n.i += 1;
      if (Array.isArray(el)) {
        stack.push(n);
        stack.push({i: 0, array: el});
        break;
      }
      result.push(el);
    }
  }
  return result;
}

function toTree(node: ?Fiber) {
  if (node == null) {
    return null;
  }
  switch (node.tag) {
    case HostRoot:
      return childrenToTree(node.child);
    case HostPortal:
      return childrenToTree(node.child);
    case ClassComponent:
      return {
        nodeType: 'component',
        type: node.type,
        props: {...node.memoizedProps},
        instance: node.stateNode,
        rendered: childrenToTree(node.child),
      };
    case FunctionalComponent:
      return {
        nodeType: 'component',
        type: node.type,
        props: {...node.memoizedProps},
        instance: null,
        rendered: childrenToTree(node.child),
      };
    case HostComponent: {
      return {
        nodeType: 'host',
        type: node.type,
        props: {...node.memoizedProps},
        instance: null, // TODO: use createNodeMock here somehow?
        rendered: flatten(nodeAndSiblingsArray(node.child).map(toTree)),
      };
    }
    case HostText:
      return node.stateNode.text;
    case Fragment:
    case ContextProvider:
    case ContextConsumer:
    case Mode:
    case Profiler:
    case ForwardRef:
      return childrenToTree(node.child);
    default:
      invariant(
        false,
        'toTree() does not yet know how to handle nodes with tag=%s',
        node.tag,
      );
  }
}

const fiberToWrapper = new WeakMap();
function wrapFiber(fiber: Fiber): ReactTestInstance {
  let wrapper = fiberToWrapper.get(fiber);
  if (wrapper === undefined && fiber.alternate !== null) {
    wrapper = fiberToWrapper.get(fiber.alternate);
  }
  if (wrapper === undefined) {
    wrapper = new ReactTestInstance(fiber);
    fiberToWrapper.set(fiber, wrapper);
  }
  return wrapper;
}

const validWrapperTypes = new Set([
  FunctionalComponent,
  ClassComponent,
  HostComponent,
  ForwardRef,
]);

class ReactTestInstance {
  _fiber: Fiber;

  _currentFiber(): Fiber {
    // Throws if this component has been unmounted.
    const fiber = findCurrentFiberUsingSlowPath(this._fiber);
    invariant(
      fiber !== null,
      "Can't read from currently-mounting component. This error is likely " +
        'caused by a bug in React. Please file an issue.',
    );
    return fiber;
  }

  constructor(fiber: Fiber) {
    invariant(
      validWrapperTypes.has(fiber.tag),
      'Unexpected object passed to ReactTestInstance constructor (tag: %s). ' +
        'This is probably a bug in React.',
      fiber.tag,
    );
    this._fiber = fiber;
  }

  get instance() {
    if (this._fiber.tag === HostComponent) {
      return ReactTestHostConfig.getPublicInstance(this._fiber.stateNode);
    } else {
      return this._fiber.stateNode;
    }
  }

  get type() {
    return this._fiber.type;
  }

  get props(): Object {
    return this._currentFiber().memoizedProps;
  }

  get parent(): ?ReactTestInstance {
    let parent = this._fiber.return;
    while (parent !== null) {
      if (validWrapperTypes.has(parent.tag)) {
        return wrapFiber(parent);
      }
      parent = parent.return;
    }
    return null;
  }

  get children(): Array<ReactTestInstance | string> {
    const children = [];
    const startingNode = this._currentFiber();
    let node: Fiber = startingNode;
    if (node.child === null) {
      return children;
    }
    node.child.return = node;
    node = node.child;
    outer: while (true) {
      let descend = false;
      if (validWrapperTypes.has(node.tag)) {
        children.push(wrapFiber(node));
      } else if (node.tag === HostText) {
        children.push('' + node.memoizedProps);
      } else {
        descend = true;
      }
      if (descend && node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      while (node.sibling === null) {
        if (node.return === startingNode) {
          break outer;
        }
        node = (node.return: any);
      }
      (node.sibling: any).return = node.return;
      node = (node.sibling: any);
    }
    return children;
  }

  // Custom search functions
  find(predicate: Predicate): ReactTestInstance {
    return expectOne(
      this.findAll(predicate, {deep: false}),
      `matching custom predicate: ${predicate.toString()}`,
    );
  }

  findByType(type: any): ReactTestInstance {
    return expectOne(
      this.findAllByType(type, {deep: false}),
      `with node type: "${type.displayName || type.name}"`,
    );
  }

  findByProps(props: Object): ReactTestInstance {
    return expectOne(
      this.findAllByProps(props, {deep: false}),
      `with props: ${JSON.stringify(props)}`,
    );
  }

  findAll(
    predicate: Predicate,
    options: ?FindOptions = null,
  ): Array<ReactTestInstance> {
    return findAll(this, predicate, options);
  }

  findAllByType(
    type: any,
    options: ?FindOptions = null,
  ): Array<ReactTestInstance> {
    return findAll(this, node => node.type === type, options);
  }

  findAllByProps(
    props: Object,
    options: ?FindOptions = null,
  ): Array<ReactTestInstance> {
    return findAll(
      this,
      node => node.props && propsMatch(node.props, props),
      options,
    );
  }
}

function findAll(
  root: ReactTestInstance,
  predicate: Predicate,
  options: ?FindOptions,
): Array<ReactTestInstance> {
  const deep = options ? options.deep : true;
  const results = [];

  if (predicate(root)) {
    results.push(root);
    if (!deep) {
      return results;
    }
  }

  root.children.forEach(child => {
    if (typeof child === 'string') {
      return;
    }
    results.push(...findAll(child, predicate, options));
  });

  return results;
}

function expectOne(
  all: Array<ReactTestInstance>,
  message: string,
): ReactTestInstance {
  if (all.length === 1) {
    return all[0];
  }

  const prefix =
    all.length === 0
      ? 'No instances found '
      : `Expected 1 but found ${all.length} instances `;

  throw new Error(prefix + message);
}

function propsMatch(props: Object, filter: Object): boolean {
  for (const key in filter) {
    if (props[key] !== filter[key]) {
      return false;
    }
  }
  return true;
}

const ReactTestRendererFiber = {
  create(element: React$Element<any>, options: TestRendererOptions) {
    let createNodeMock = defaultTestOptions.createNodeMock;
    let isAsync = false;
    if (typeof options === 'object' && options !== null) {
      if (typeof options.createNodeMock === 'function') {
        createNodeMock = options.createNodeMock;
      }
      if (options.unstable_isAsync === true) {
        isAsync = true;
      }
    }
    let container = {
      children: [],
      createNodeMock,
      tag: 'CONTAINER',
    };
    let root: FiberRoot | null = TestRenderer.createContainer(
      container,
      isAsync,
      false,
    );
    invariant(root != null, 'something went wrong');
    TestRenderer.updateContainer(element, root, null, null);

    const entry = {
      root: undefined, // makes flow happy
      // we define a 'getter' for 'root' below using 'Object.defineProperty'
      toJSON(): Array<ReactTestRendererNode> | ReactTestRendererNode | null {
        if (root == null || root.current == null || container == null) {
          return null;
        }
        if (container.children.length === 0) {
          return null;
        }
        if (container.children.length === 1) {
          return toJSON(container.children[0]);
        }
        return container.children.map(toJSON);
      },
      toTree() {
        if (root == null || root.current == null) {
          return null;
        }
        return toTree(root.current);
      },
      update(newElement: React$Element<any>) {
        if (root == null || root.current == null) {
          return;
        }
        TestRenderer.updateContainer(newElement, root, null, null);
      },
      unmount() {
        if (root == null || root.current == null) {
          return;
        }
        TestRenderer.updateContainer(null, root, null, null);
        container = null;
        root = null;
      },
      getInstance() {
        if (root == null || root.current == null) {
          return null;
        }
        return TestRenderer.getPublicRootInstance(root);
      },
      unstable_flushAll: TestRendererScheduling.flushAll,
      unstable_flushSync(fn: Function) {
        return TestRendererScheduling.withCleanYields(() => {
          TestRenderer.flushSync(fn);
        });
      },
      unstable_flushThrough: TestRendererScheduling.flushThrough,
      unstable_yield: TestRendererScheduling.yieldValue,
    };

    Object.defineProperty(
      entry,
      'root',
      ({
        configurable: true,
        enumerable: true,
        get: function() {
          if (root === null || root.current.child === null) {
            throw new Error("Can't access .root on unmounted test renderer");
          }
          return wrapFiber(root.current.child);
        },
      }: Object),
    );

    return entry;
  },

  /* eslint-disable camelcase */
  unstable_batchedUpdates: batchedUpdates,
  /* eslint-enable camelcase */

  unstable_setNowImplementation: TestRendererScheduling.setNowImplementation,
};

export default ReactTestRendererFiber;
