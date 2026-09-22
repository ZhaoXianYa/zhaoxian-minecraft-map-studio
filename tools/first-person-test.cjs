const assert=require('assert/strict'),THREE=require('three')
const listeners=new Map();global.document={addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k),exitPointerLock(){this.pointerLockElement=null}};global.window={addEventListener(){},removeEventListener(){}}
const dom={addEventListener(){},removeEventListener(){},requestPointerLock(){document.pointerLockElement=this}}
const {FirstPersonControls}=require('../src/renderer/first-person.cjs'),camera=new THREE.PerspectiveCamera(),c=new FirstPersonControls(camera,dom)
dom.requestPointerLock();c.down({code:'KeyW',preventDefault(){}});c.last-=50;c.update();assert(camera.position.z<0)
c.unlock();assert.equal(c.keys.size,0);c.mouse({movementX:100,movementY:99999});assert.equal(camera.rotation.x,-1.56);assert(camera.rotation.y<0)
c.dispose();assert.equal(listeners.size,0);assert.equal(document.pointerLockElement,null)
console.log('PASS: forward movement, pitch limit, unlock clears keys, disposal removes listeners')
