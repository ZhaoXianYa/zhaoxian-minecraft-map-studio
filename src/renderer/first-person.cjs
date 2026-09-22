const THREE=require('three')
class FirstPersonControls{
 constructor(camera,dom){
  this.camera=camera;this.dom=dom;this.target=camera.position;this.keys=new Set();this.last=performance.now();camera.rotation.order='YXZ'
  this.down=e=>{if(document.pointerLockElement!==dom)return;if(['KeyW','KeyA','KeyS','KeyD','Space','ControlLeft','ShiftLeft'].includes(e.code)){e.preventDefault();this.keys.add(e.code)}}
  this.up=e=>this.keys.delete(e.code)
  this.mouse=e=>{if(document.pointerLockElement!==dom)return;camera.rotation.y-=e.movementX*.002;camera.rotation.x=Math.max(-1.56,Math.min(1.56,camera.rotation.x-e.movementY*.002))}
  this.unlock=()=>this.keys.clear();this.click=()=>{try{dom.requestPointerLock()?.catch?.(()=>{})}catch{}}
  document.addEventListener('keydown',this.down);document.addEventListener('keyup',this.up);document.addEventListener('mousemove',this.mouse);document.addEventListener('pointerlockchange',this.unlock);window.addEventListener('blur',this.unlock);dom.addEventListener('click',this.click)
 }
 update(){
  const now=performance.now(),dt=Math.min(.05,(now-this.last)/1000);this.last=now;if(document.pointerLockElement!==this.dom)return
  const yaw=this.camera.rotation.y,v=new THREE.Vector3(),f=Number(this.keys.has('KeyW'))-Number(this.keys.has('KeyS')),r=Number(this.keys.has('KeyD'))-Number(this.keys.has('KeyA'))
  v.set(-Math.sin(yaw)*f+Math.cos(yaw)*r,Number(this.keys.has('Space'))-Number(this.keys.has('ControlLeft')),-Math.cos(yaw)*f-Math.sin(yaw)*r)
  if(v.lengthSq())this.camera.position.addScaledVector(v.normalize(),dt*6*(this.keys.has('ShiftLeft')?3:1))
 }
 dispose(){document.removeEventListener('keydown',this.down);document.removeEventListener('keyup',this.up);document.removeEventListener('mousemove',this.mouse);document.removeEventListener('pointerlockchange',this.unlock);window.removeEventListener('blur',this.unlock);this.dom.removeEventListener('click',this.click);this.keys.clear();if(document.pointerLockElement===this.dom)document.exitPointerLock()}
}
module.exports={FirstPersonControls}
