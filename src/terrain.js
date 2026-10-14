export function riverX(z) { return 17 + Math.sin(z / 23) * 7 + Math.sin(z / 51) * 5; }
export function heightAt(x,z) {
 const dist=Math.abs(x-riverX(z));const hills=1.3+Math.sin(x/21)*1.7+Math.cos(z/27)*1.2+Math.sin((x+z)/31)*.8;
 if(dist<4.4)return -.8;if(dist<6)return -.8+(dist-4.4)/1.6*.98;return .18+Math.max(.1,hills-.18)*Math.min(1,(dist-6)/10);
}
export function waterAt(x,z) { return Math.abs(x-riverX(z))<6; }
