var d = new Date();
var h = d.getHours();

const nightChoice = ["dmit49"];
const dayChoice = ["dmit49"];

var nodeList;
console.log("切换开始");
if (h >= 18 || h < 1) {
    nodeList = nightChoice;
} else {
    nodeList = dayChoice;
}

const nodeName = nodeList[0];
$surge.setSelectGroupPolicy("✈️ 节点选择", nodeName);
$done();
