var d = new Date();
var h = d.getHours();

const nightChoice = ["tw-dmit"];
const dayChoice = ["tw"];

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
